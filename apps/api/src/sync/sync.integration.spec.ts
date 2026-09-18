/*
Copyright (C) 2026 Steven E. Waldren

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * P2.S1b — `POST /api/v1/sync/push` and `GET /api/v1/sync/delta` against a
 * real PostgreSQL instance.
 *
 * Everything `docs/sync-contract.md` explicitly owed this sprint is proven
 * here rather than asserted in a comment:
 *
 *  - §5.3's cursor invariant, with the interleaved out-of-order commit the
 *    contract demands. That test fails against a naive `ORDER BY
 *    server_sequence` and is the reason the delta query is not one.
 *  - §3.7's byte-for-byte replay, and that a replayed batch creates no
 *    second row.
 *  - §4.1's two count-equality obligations: `sync_applied` rows equal
 *    `accepted` results, and `sync_conflict_loser` rows equal conflicts
 *    resolved.
 *  - §3.5's closed-set obligation: every stored `rejection_field` is a member
 *    of `SYNC_FIELD_PATH`. Storage is free text; the wire type is closed; the
 *    replay guarantee is served from those columns, so a value outside the
 *    set would be replayed to a client verbatim forever.
 *  - §6.1's seven protocol conditions, each returning a body whose only keys
 *    are `error` -> `code`.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Logger as NestLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createApiClient, ApiError } from '@ostomy/core/api-client';
import { SYNC_FIELD_PATH } from '@ostomy/core/sync';
import { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../app.module';
import { applyJsonBodyLimit } from '../http/body-limit';
import { PATIENT_JWKS_RESOLVER } from '../auth/patient-jwks-resolver.token';
import type { AppConfig } from '../config/env.schema';
import { createTestOidcIssuer, type TestOidcIssuer } from '../test-support/oidc-test-tokens';
import { THRESHOLD_KEY } from '../thresholds/thresholds.service';
import { SYNC_THROTTLE } from './sync-throttle';

const API_ROOT = path.resolve(__dirname, '..', '..');

function isDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = isDockerAvailable();
if (!dockerAvailable) {
  if (process.env.CI) {
    throw new Error(
      "[sync.integration.spec.ts] Docker is not reachable, but CI is set — refusing to silently skip P2.S1b's sync proof.",
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    '[sync.integration.spec.ts] Docker is not reachable — skipping. Run with a Docker daemon available (e.g. `pnpm --filter @ostomy/api test:integration`).',
  );
}

const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'sync-integration-test-only-password';
const ISSUER = 'https://mock-oidc.test/patient-issuer';
const AUDIENCE = 'ostomy-patient-app';
const SOFT_WARNING_ML = 2000;
const CLOCK_SKEW_SECONDS = 300;
const STOMA_OUTPUT_CODE = '79560-9';

interface SeededPatient {
  readonly patientId: string;
  readonly subject: string;
  readonly token: string;
}

describe.skipIf(!dockerAvailable)('P2.S1b — sync push and delta', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let db: PgClient;
  let runtimeDatabaseUrl: string;
  let issuer: TestOidcIssuer;
  let baseUrl: string;
  let patientA: SeededPatient;
  let patientB: SeededPatient;

  function testConfig(): AppConfig {
    return {
      nodeEnv: 'test',
      port: 0,
      logLevel: 'silent',
      oidcClockToleranceSeconds: 30,
      syncPushMaxOperations: 500,
      syncDeltaDefaultLimit: 200,
      syncDeltaMaxLimit: 1000,
      databaseUrl: runtimeDatabaseUrl,
      oidc: {
        issuer: ISSUER,
        jwksUri: `${ISSUER}/.well-known/jwks.json`,
        audience: AUDIENCE,
        claimMapping: { subjectClaim: 'sub' },
      },
      adminOidc: {
        issuer: 'https://mock-oidc.test/admin-issuer',
        jwksUri: 'https://mock-oidc.test/admin-issuer/.well-known/jwks.json',
        audience: 'ostomy-admin-console',
        claimMapping: { subjectClaim: 'sub' },
      },
      objectStorage: {
        endpoint: 'http://minio.test:9000',
        region: 'us-east-1',
        accessKeyId: 'test',
        secretAccessKey: 'test',
        forcePathStyle: true,
      },
    };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('ostomy_sync_test')
      .withUsername('ostomy_owner')
      .withPassword('owner-test-only-password')
      .start();
    const ownerDatabaseUrl = container.getConnectionUri();

    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        cwd: API_ROOT,
        env: { ...process.env, MIGRATION_DATABASE_URL: ownerDatabaseUrl },
        stdio: 'pipe',
      },
    );

    const owner = new PgClient({ connectionString: ownerDatabaseUrl });
    await owner.connect();
    try {
      await owner.query(`ALTER ROLE "${RUNTIME_ROLE}" WITH LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
      await owner.query(
        `INSERT INTO validation_thresholds (id, threshold_key, tier, value, unit, updated_at)
         VALUES
           (gen_random_uuid(), $1, 'TIER_2_SOFT_WARNING', $3, 'mL', now()),
           (gen_random_uuid(), $2, 'OPERATIONAL', $4, 'seconds', now())
         ON CONFLICT (threshold_key) DO UPDATE SET
           tier = EXCLUDED.tier, value = EXCLUDED.value,
           unit = EXCLUDED.unit, updated_at = EXCLUDED.updated_at`,
        [
          THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML,
          THRESHOLD_KEY.SYNC_CLOCK_SKEW_ALLOWANCE_SECONDS,
          SOFT_WARNING_ML,
          CLOCK_SKEW_SECONDS,
        ],
      );
    } finally {
      await owner.end();
    }

    const host = container.getHost();
    const port = container.getPort();
    const database = container.getDatabase();
    runtimeDatabaseUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@${host}:${port}/${database}`;

    db = new PgClient({ connectionString: runtimeDatabaseUrl });
    await db.connect();

    issuer = await createTestOidcIssuer();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(testConfig())],
    })
      .overrideProvider(PATIENT_JWKS_RESOLVER)
      .useValue(issuer.getKey)
      .compile();

    app = moduleRef.createNestApplication();
    // Exactly what main.ts does. Without it this suite would run against
    // Express's 100 KB default while production ran with 1 MB, and the
    // maximum-batch test below would prove nothing about either.
    applyJsonBodyLimit(app);
    app.setGlobalPrefix('api/v1');
    // A real listener, not just `init()`: the generated client speaks HTTP to
    // a URL rather than to a supertest handle.
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

    patientA = await seedPatient();
    patientB = await seedPatient();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await container?.stop();
  });

  async function seedPatient(): Promise<SeededPatient> {
    const patientId = randomUUID();
    const subject = `patient-${randomUUID()}`;
    await db.query(`INSERT INTO patients (id, oidc_subject, updated_at) VALUES ($1, $2, now())`, [
      patientId,
      subject,
    ]);
    await db.query(
      `INSERT INTO profiles (id, patient_id, ostomy_type, surgery_date, measurement_system, client_updated_at, updated_at)
       VALUES ($1, $2, 'ILEOSTOMY', DATE '2026-01-15', 'METRIC', now(), now())`,
      [randomUUID(), patientId],
    );
    const token = await issuer.sign({ issuer: ISSUER, audience: AUDIENCE, subject });
    return { patientId, subject, token };
  }

  // -------------------------------------------------------------------------
  // Request builders
  // -------------------------------------------------------------------------

  function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      resourceType: 'Observation',
      status: 'final',
      code: STOMA_OUTPUT_CODE,
      valueQuantity: { value: 350.5, unit: 'mL' },
      effectiveDateTime: '2026-09-07T14:00:00.000Z',
      method: null,
      enteredMeasurementSystem: 'metric',
      enteredTimezone: 'America/Chicago',
      ...overrides,
    };
  }

  function createOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const entityId = (overrides.entityId as string | undefined) ?? randomUUID();
    return {
      operationId: randomUUID(),
      entityType: 'Observation',
      entityId,
      operationType: 'create',
      clientTimestamp: '2026-09-07T22:04:11.412Z',
      payload: payload({ id: entityId }),
      ...overrides,
      // `payload.id` must track `entityId` even when the caller overrode one
      // of them; §7.2 makes a mismatch a protocol error, which is its own
      // test rather than an accident in every other one.
      ...(overrides.payload === undefined && overrides.entityId !== undefined
        ? { payload: payload({ id: entityId }) }
        : {}),
    };
  }

  function push(patient: SeededPatient, operations: unknown[]) {
    return request(app.getHttpServer())
      .post('/api/v1/sync/push')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ operations });
  }

  function delta(patient: SeededPatient, query: Record<string, string | number>) {
    return request(app.getHttpServer())
      .get('/api/v1/sync/delta')
      .set('Authorization', `Bearer ${patient.token}`)
      .query(query);
  }

  async function observationRows(entityId: string): Promise<Array<Record<string, unknown>>> {
    const result = await db.query(`SELECT * FROM observations WHERE id = $1`, [entityId]);
    return result.rows;
  }

  async function auditRows(entityId: string): Promise<Array<Record<string, unknown>>> {
    const result = await db.query(
      `SELECT action, reason_code, before_value, after_value, correlation_id
       FROM audit_events WHERE entity_id = $1 ORDER BY occurred_at ASC, id ASC`,
      [entityId],
    );
    return result.rows;
  }

  async function operationRow(operationId: string): Promise<Record<string, unknown> | undefined> {
    const result = await db.query(`SELECT * FROM sync_operations WHERE operation_id = $1`, [
      operationId,
    ]);
    return result.rows[0];
  }

  // -------------------------------------------------------------------------

  /**
   * `Meal` (§7.4, SRS AC 2.4) — the first app-native synced entity. These
   * assert that it behaves IDENTICALLY to an observation everywhere the
   * contract is about sync rather than about content: conflict resolution,
   * tombstones, audit obligations and the delta cursor. A meal that resolved
   * conflicts differently would make §4 mean two things.
   */
  describe('§7.4 — Meal, the first app-native synced entity', () => {
    /**
     * Its OWN patient, for two reasons that both bit before it had one.
     *
     * §2's per-patient rate limit is real and this block pushes a lot: sharing
     * `patientA` exhausted it and turned every LATER test in this file into a
     * 429, which looks like a broken rate limiter rather than a noisy
     * neighbour. And the delta assertions below pull `since=0`, so a shared
     * patient would have them reading every row other tests had written —
     * making "orders observations and meals together" pass or fail on
     * execution order.
     */
    let mealPatient: SeededPatient;

    beforeAll(async () => {
      mealPatient = await seedPatient();
    });

    function mealOp(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      const entityId = (overrides.entityId as string | undefined) ?? randomUUID();
      return {
        operationId: randomUUID(),
        entityType: 'Meal',
        entityId,
        operationType: 'create',
        clientTimestamp: '2026-09-07T22:04:11.412Z',
        payload: {
          id: entityId,
          description: 'Porridge and a banana',
          size: 'medium',
          tagCodes: ['high_fibre'],
          effectiveDateTime: '2026-09-07T14:00:00.000Z',
          enteredTimezone: 'America/Chicago',
        },
        ...overrides,
      };
    }

    function deleteMealOp(entityId: unknown, clientTimestamp: string): Record<string, unknown> {
      return {
        operationId: randomUUID(),
        entityType: 'Meal',
        entityId,
        operationType: 'delete',
        clientTimestamp,
      };
    }

    async function mealRows(entityId: string): Promise<Array<Record<string, unknown>>> {
      const result = await db.query(`SELECT * FROM meals WHERE id = $1`, [entityId]);
      return result.rows;
    }

    it('applies a create and reports accepted with a server-sequence receipt', async () => {
      const op = mealOp();
      const response = await push(mealPatient, [op]);

      expect(response.status).toBe(200);
      expect(response.body.results[0]).toMatchObject({
        operationId: op.operationId,
        status: 'accepted',
        entityId: op.entityId,
      });
      expect(response.body.results[0].appliedServerSequence).toEqual(expect.any(String));
    });

    it('stores the tags as codes and the size as the stored enum', async () => {
      const op = mealOp();
      await push(mealPatient, [op]);

      const [row] = await mealRows(op.entityId as string);
      expect(row?.size).toBe('MEDIUM');
      expect(row?.tag_codes).toEqual(['high_fibre']);
    });

    it('refuses an absent size rather than defaulting one (AC 2.4 AC2)', async () => {
      const op = mealOp();
      const payload = { ...(op.payload as Record<string, unknown>) };
      delete payload.size;

      const response = await push(mealPatient, [{ ...op, payload }]);

      expect(response.body.results[0]).toMatchObject({
        status: 'rejected',
        field: 'size',
        reasonCode: 'PAYLOAD_FIELD_INVALID',
      });
    });

    /**
     * The timestamp rules a meal IS subject to, shared with volumetric
     * entries through `packages/core` so the two cannot disagree about what
     * "in the future" means.
     */
    it('rejects a meal eaten beyond the clock-skew allowance, naming effectiveDateTime', async () => {
      const farFuture = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      const op = mealOp();
      const response = await push(mealPatient, [
        {
          ...op,
          payload: { ...(op.payload as Record<string, unknown>), effectiveDateTime: farFuture },
        },
      ]);

      expect(response.body.results[0]).toMatchObject({
        status: 'rejected',
        field: 'effectiveDateTime',
        reasonCode: 'EFFECTIVE_DATE_TIME_IN_FUTURE',
      });
    });

    it('refuses an update naming an entity this patient does not have (§6.2)', async () => {
      const response = await push(mealPatient, [
        { ...mealOp(), operationType: 'update', clientTimestamp: '2026-09-08T10:00:00.000Z' },
      ]);

      expect(response.body.results[0]).toMatchObject({
        status: 'rejected',
        field: 'entityId',
        reasonCode: 'ENTITY_NOT_FOUND',
      });
    });

    describe('§4 — last-write-wins, identical to an observation', () => {
      it('refuses to apply an older update and reports superseded', async () => {
        const created = mealOp();
        await push(mealPatient, [created]);

        const older = await push(mealPatient, [
          {
            ...mealOp({ entityId: created.entityId }),
            operationType: 'update',
            clientTimestamp: '2026-09-06T10:00:00.000Z',
          },
        ]);

        expect(older.body.results[0]).toMatchObject({ status: 'superseded' });
      });

      it('applies a newer update and audits the displaced version', async () => {
        const created = mealOp();
        await push(mealPatient, [created]);

        const newer = mealOp({ entityId: created.entityId });
        const response = await push(mealPatient, [
          {
            ...newer,
            operationType: 'update',
            clientTimestamp: '2026-09-08T10:00:00.000Z',
            payload: { ...(newer.payload as Record<string, unknown>), size: 'large' },
          },
        ]);

        expect(response.body.results[0]).toMatchObject({ status: 'accepted' });

        const audits = await auditRows(created.entityId as string);
        expect(audits.map((row) => row.reason_code)).toContain('sync_conflict_loser');
      });

      it('lets an update at T2 resurrect a meal deleted at T1', async () => {
        const created = mealOp();
        await push(mealPatient, [created]);
        await push(mealPatient, [deleteMealOp(created.entityId, '2026-09-08T10:00:00.000Z')]);

        const revived = mealOp({ entityId: created.entityId });
        const response = await push(mealPatient, [
          { ...revived, operationType: 'update', clientTimestamp: '2026-09-09T10:00:00.000Z' },
        ]);

        expect(response.body.results[0]).toMatchObject({ status: 'accepted' });
        const [row] = await mealRows(created.entityId as string);
        expect(row?.deleted_at).toBeNull();
      });

      /** §4.1: a delete audits the FULL pre-deletion state, because after a purge that row is the only surviving copy. */
      it('audits a delete with the meal as it was before deletion', async () => {
        const created = mealOp();
        await push(mealPatient, [created]);
        await push(mealPatient, [deleteMealOp(created.entityId, '2026-09-08T10:00:00.000Z')]);

        const audits = await auditRows(created.entityId as string);
        const deleteAudit = audits.find((row) => row.action === 'DELETE');

        expect(deleteAudit?.before_value).toMatchObject({ size: 'MEDIUM' });
        expect(deleteAudit?.after_value).toBeNull();
      });
    });

    describe('§5 — meals appear in the delta, interleaved by the shared sequence', () => {
      it('returns a created meal as an upsert carrying no resourceType', async () => {
        const op = mealOp();
        await push(mealPatient, [op]);

        const response = await delta(mealPatient, { since: '0', limit: '500' });
        const change = response.body.changes.find(
          (candidate: { entityId: string }) => candidate.entityId === op.entityId,
        );

        expect(change).toMatchObject({ entityType: 'Meal', deleted: false });
        expect(change.payload).not.toHaveProperty('resourceType');
        expect(change.payload).toMatchObject({ size: 'medium', tagCodes: ['high_fibre'] });
      });

      it('returns a deleted meal as a tombstone carrying no payload at all (§5.2)', async () => {
        const op = mealOp();
        await push(mealPatient, [op]);
        await push(mealPatient, [deleteMealOp(op.entityId, '2026-09-08T10:00:00.000Z')]);

        const response = await delta(mealPatient, { since: '0', limit: '500' });
        const change = response.body.changes.find(
          (candidate: { entityId: string }) => candidate.entityId === op.entityId,
        );

        expect(change).toMatchObject({ entityType: 'Meal', deleted: true });
        expect(change).not.toHaveProperty('payload');
      });

      /**
       * The reason the shared `sync_sequence` exists. A page that ordered each
       * table separately would make one cursor mean something different per
       * entity type, and §5.3's invariant is stated over the cursor.
       */
      it('orders observations and meals together by server sequence, ascending', async () => {
        await push(mealPatient, [createOp()]);
        await push(mealPatient, [mealOp()]);
        await push(mealPatient, [createOp()]);

        const response = await delta(mealPatient, { since: '0', limit: '500' });
        const sequences = response.body.changes.map((candidate: { serverSequence: string }) =>
          BigInt(candidate.serverSequence),
        );

        for (let index = 1; index < sequences.length; index += 1) {
          expect(sequences[index] > sequences[index - 1]).toBe(true);
        }

        const types = response.body.changes.map(
          (candidate: { entityType: string }) => candidate.entityType,
        );
        expect(types).toContain('Meal');
        expect(types).toContain('Observation');
      });
    });
  });

  describe('§3.4 — one result per operation, in request order', () => {
    it('applies a create and reports accepted with a server-sequence receipt', async () => {
      const op = createOp();
      const response = await push(patientA, [op]);

      expect(response.status).toBe(200);
      expect(response.body.results).toHaveLength(1);
      expect(response.body.results[0]).toEqual({
        operationId: op.operationId,
        status: 'accepted',
        entityId: op.entityId,
        appliedServerSequence: expect.any(String),
        replayed: false,
      });

      const rows = await observationRows(op.entityId as string);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.value_quantity_value)).toBe(350.5);
      expect(rows[0]!.patient_id).toBe(patientA.patientId);
    });

    it('returns results in request order, and one bad operation does not block the rest', async () => {
      // ADR-0001 point 2: a batch never fails as a unit for data reasons. One
      // implausible row must not block every subsequent entry a patient made
      // while offline — which is the whole reason push is not all-or-nothing.
      const good1 = createOp();
      const bad = createOp();
      (bad.payload as Record<string, unknown>).valueQuantity = { value: -5, unit: 'mL' };
      const good2 = createOp();

      const response = await push(patientA, [good1, bad, good2]);

      expect(response.status).toBe(200);
      expect(response.body.results.map((r: { status: string }) => r.status)).toEqual([
        'accepted',
        'rejected',
        'accepted',
      ]);
      expect(response.body.results.map((r: { operationId: string }) => r.operationId)).toEqual([
        good1.operationId,
        bad.operationId,
        good2.operationId,
      ]);

      expect(await observationRows(good1.entityId as string)).toHaveLength(1);
      expect(await observationRows(bad.entityId as string)).toHaveLength(0);
      expect(await observationRows(good2.entityId as string)).toHaveLength(1);
    });

    it('accepts a Tier 2 value and never represents the warning on the wire', async () => {
      // §6.2: a soft warning is not a rejection and never becomes one. There
      // is no wire representation of a Tier 2 outcome in a push response,
      // deliberately — a field for it is a field someone will branch on.
      const op = createOp();
      (op.payload as Record<string, unknown>).valueQuantity = {
        value: SOFT_WARNING_ML + 500,
        unit: 'mL',
      };

      const response = await push(patientA, [op]);

      expect(response.body.results[0].status).toBe('accepted');
      expect(JSON.stringify(response.body)).not.toContain('warning');
      expect(await observationRows(op.entityId as string)).toHaveLength(1);
    });
  });

  describe('§4 — last-write-wins by client timestamp', () => {
    it('applies a newer update and audits the displaced stored version', async () => {
      const create = createOp({ clientTimestamp: '2026-09-07T10:00:00.000Z' });
      await push(patientA, [create]).expect(200);

      const update = createOp({
        entityId: create.entityId,
        operationType: 'update',
        clientTimestamp: '2026-09-07T12:00:00.000Z',
      });
      (update.payload as Record<string, unknown>).valueQuantity = { value: 900, unit: 'mL' };

      const response = await push(patientA, [update]);
      expect(response.body.results[0].status).toBe('accepted');

      const rows = await observationRows(create.entityId as string);
      expect(Number(rows[0]!.value_quantity_value)).toBe(900);

      // §4.1: the STORED version, as it was before the write, goes to the
      // audit log — the only reason last-write-wins is acceptable for
      // clinical data at all.
      const loser = (await auditRows(create.entityId as string)).filter(
        (row) => row.reason_code === 'sync_conflict_loser',
      );
      expect(loser).toHaveLength(1);
      expect((loser[0]!.before_value as { valueQuantityValue: unknown }).valueQuantityValue).toBe(
        350.5,
      );
    });

    it('refuses to apply an older update, reports superseded, and audits the incoming loser', async () => {
      const create = createOp({ clientTimestamp: '2026-09-07T12:00:00.000Z' });
      await push(patientA, [create]).expect(200);
      const winningSequence = (await observationRows(create.entityId as string))[0]!
        .server_sequence;

      const stale = createOp({
        entityId: create.entityId,
        operationType: 'update',
        clientTimestamp: '2026-09-07T09:00:00.000Z',
      });
      (stale.payload as Record<string, unknown>).valueQuantity = { value: 111, unit: 'mL' };

      const response = await push(patientA, [stale]);

      // Not `accepted` (which would tell the client its version is live when
      // it is not) and not `rejected` (which would send a correct entry to
      // the correction inbox). §3.5: it is a third outcome because it is a
      // third thing.
      expect(response.body.results[0]).toEqual({
        operationId: stale.operationId,
        status: 'superseded',
        entityId: stale.entityId,
        // §3.6: the WINNING row's sequence, not this operation's — this
        // operation never got one.
        appliedServerSequence: String(winningSequence),
        replayed: false,
      });

      // The stored row is untouched.
      expect(
        Number((await observationRows(create.entityId as string))[0]!.value_quantity_value),
      ).toBe(350.5);

      const loser = (await auditRows(create.entityId as string)).filter(
        (row) => row.reason_code === 'sync_conflict_loser',
      );
      expect(loser).toHaveLength(1);
      // The INCOMING version that lost, not the stored one.
      expect((loser[0]!.before_value as { valueQuantityValue: unknown }).valueQuantityValue).toBe(
        111,
      );
    });

    it('resolves an equal timestamp in favour of the incoming operation', async () => {
      // §4: the alternative makes a legitimate correction made inside the
      // same millisecond disappear with no signal, and ties are a
      // millisecond-resolution artifact rather than real simultaneity.
      const at = '2026-09-07T11:11:11.111Z';
      const create = createOp({ clientTimestamp: at });
      await push(patientA, [create]).expect(200);

      const tie = createOp({
        entityId: create.entityId,
        operationType: 'update',
        clientTimestamp: at,
      });
      (tie.payload as Record<string, unknown>).valueQuantity = { value: 777, unit: 'mL' };

      const response = await push(patientA, [tie]);

      expect(response.body.results[0].status).toBe('accepted');
      expect(
        Number((await observationRows(create.entityId as string))[0]!.value_quantity_value),
      ).toBe(777);
    });

    it('treats a create against an existing row as last-write-wins, never a rejection', async () => {
      // §4: the reachable case is not a client bug — the server applies a
      // create, the response is lost, the client re-pushes with a NEW
      // operation id. Rejecting would put a correct entry in the correction
      // inbox carrying a code §6.4 says must not be shown to the patient.
      const first = createOp({ clientTimestamp: '2026-09-07T10:00:00.000Z' });
      await push(patientA, [first]).expect(200);

      const again = createOp({
        entityId: first.entityId,
        clientTimestamp: '2026-09-07T11:00:00.000Z',
      });
      (again.payload as Record<string, unknown>).valueQuantity = { value: 222, unit: 'mL' };

      const response = await push(patientA, [again]);

      expect(response.body.results[0].status).toBe('accepted');
      expect(await observationRows(first.entityId as string)).toHaveLength(1);
      expect(
        Number((await observationRows(first.entityId as string))[0]!.value_quantity_value),
      ).toBe(222);
    });

    it('lets an update at T2 resurrect a row deleted at T1', async () => {
      // §4: deletes participate like any other operation. A patient who
      // deletes an entry offline and then edits it before reconnecting must
      // not have the edit rejected — that is AC 13.1 AC4's failure arriving
      // through the back door.
      const create = createOp({ clientTimestamp: '2026-09-07T08:00:00.000Z' });
      await push(patientA, [create]).expect(200);

      const del = {
        operationId: randomUUID(),
        entityType: 'Observation',
        entityId: create.entityId,
        operationType: 'delete',
        clientTimestamp: '2026-09-07T09:00:00.000Z',
      };
      await push(patientA, [del]).expect(200);
      expect((await observationRows(create.entityId as string))[0]!.deleted_at).not.toBeNull();

      const resurrect = createOp({
        entityId: create.entityId,
        operationType: 'update',
        clientTimestamp: '2026-09-07T10:00:00.000Z',
      });
      const response = await push(patientA, [resurrect]);

      expect(response.body.results[0].status).toBe('accepted');
      const rows = await observationRows(create.entityId as string);
      expect(rows[0]!.deleted_at).toBeNull();
    });

    it('audits a delete with the full pre-deletion state', async () => {
      // §4.1: the tombstone carries nothing on the wire (§5.2) precisely
      // because the audit store carries everything. Once the §10 purge policy
      // lands, this row is the only surviving copy of what was deleted.
      const create = createOp({ clientTimestamp: '2026-09-07T08:00:00.000Z' });
      await push(patientA, [create]).expect(200);

      const del = {
        operationId: randomUUID(),
        entityType: 'Observation',
        entityId: create.entityId,
        operationType: 'delete',
        clientTimestamp: '2026-09-07T09:00:00.000Z',
      };
      await push(patientA, [del]).expect(200);

      const applied = (await auditRows(create.entityId as string)).filter(
        (row) => row.action === 'DELETE',
      );
      expect(applied).toHaveLength(1);
      expect(applied[0]!.after_value).toBeNull();
      expect((applied[0]!.before_value as { valueQuantityValue: unknown }).valueQuantityValue).toBe(
        350.5,
      );
    });
  });
  describe('§3.7 — idempotency on (patient, operationId)', () => {
    it('returns the first result byte-for-byte with replayed: true, and creates no second row', async () => {
      // The ordinary case on a phone, not the exotic one: push, lose the
      // connection before reading the response, push again.
      const op = createOp();
      const first = await push(patientA, [op]);
      expect(first.body.results[0].replayed).toBe(false);

      const second = await push(patientA, [op]);

      expect(second.status).toBe(200);
      expect(second.body.results[0]).toEqual({ ...first.body.results[0], replayed: true });
      // Byte-for-byte apart from `replayed` — including the server sequence,
      // which a re-derivation would have changed.
      expect(second.body.results[0].appliedServerSequence).toBe(
        first.body.results[0].appliedServerSequence,
      );
      expect(await observationRows(op.entityId as string)).toHaveLength(1);
    });

    it('replays a rejection as a rejection, carrying the original reason and field', async () => {
      const op = createOp();
      (op.payload as Record<string, unknown>).valueQuantity = { value: -1, unit: 'mL' };

      const first = await push(patientA, [op]);
      expect(first.body.results[0].status).toBe('rejected');

      const second = await push(patientA, [op]);
      expect(second.body.results[0]).toEqual({ ...first.body.results[0], replayed: true });
      expect(second.body.results[0].reasonCode).toBe('VALUE_NOT_POSITIVE');
    });

    it('replays a superseded result as superseded, not as accepted', async () => {
      const create = createOp({ clientTimestamp: '2026-09-07T12:00:00.000Z' });
      await push(patientA, [create]).expect(200);
      const stale = createOp({
        entityId: create.entityId,
        operationType: 'update',
        clientTimestamp: '2026-09-07T09:00:00.000Z',
      });

      const first = await push(patientA, [stale]);
      expect(first.body.results[0].status).toBe('superseded');

      const second = await push(patientA, [stale]);
      expect(second.body.results[0]).toEqual({ ...first.body.results[0], replayed: true });
    });

    it('scopes the replay check to the patient, so one patient cannot consume another operation id', async () => {
      // §3.7: the operation id is chosen by an untrusted offline device and
      // is not patient-scoped by construction. A global uniqueness check
      // would let patient A's write cause patient B's distinct push to be
      // refused as a replay.
      const sharedOperationId = randomUUID();
      const opA = createOp({ operationId: sharedOperationId });
      const opB = createOp({ operationId: sharedOperationId });

      const a = await push(patientA, [opA]);
      const b = await push(patientB, [opB]);

      expect(a.body.results[0].status).toBe('accepted');
      expect(a.body.results[0].replayed).toBe(false);
      // B's is a distinct write, not a replay of A's.
      expect(b.body.results[0].status).toBe('accepted');
      expect(b.body.results[0].replayed).toBe(false);
      expect(await observationRows(opA.entityId as string)).toHaveLength(1);
      expect(await observationRows(opB.entityId as string)).toHaveLength(1);
    });

    it('refuses a batch containing two operations with the same operationId', async () => {
      // §3.7: MALFORMED_REQUEST for the whole request, NOT a replay of the
      // first — an id is minted once at enqueue, so two in one batch means
      // the queue is broken, and treating the second as a replay would
      // silently discard a write the client believed it had sent.
      const sharedId = randomUUID();
      const response = await push(patientA, [
        createOp({ operationId: sharedId }),
        createOp({ operationId: sharedId }),
      ]);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: { code: 'MALFORMED_REQUEST' } });
    });
  });

  describe('§4.1 — the audit obligations, counted', () => {
    it('writes one sync_applied row per accepted operation, each naming its own entity', async () => {
      // A batch-level event would satisfy a route-scoped trip-wire while
      // making "what happened to this record?" unanswerable for every write
      // that arrived over sync — which on the only offline-capable client is
      // most of them.
      const ops = [createOp(), createOp(), createOp()];
      const response = await push(patientA, ops);

      const accepted = response.body.results.filter(
        (r: { status: string }) => r.status === 'accepted',
      );
      expect(accepted).toHaveLength(3);

      let appliedRows = 0;
      for (const op of ops) {
        const rows = (await auditRows(op.entityId as string)).filter(
          (row) => row.reason_code === 'sync_applied',
        );
        expect(rows).toHaveLength(1);
        appliedRows += rows.length;
      }

      // The count equality §4.1 owed this sprint.
      expect(appliedRows).toBe(accepted.length);
    });

    it('writes one sync_conflict_loser row per conflict resolved, in both directions', async () => {
      // Two conflicts, one of each kind: an accepted operation that displaced
      // a stored version, and a superseded operation that lost.
      const base = createOp({ clientTimestamp: '2026-09-07T10:00:00.000Z' });
      await push(patientA, [base]).expect(200);

      const newer = createOp({
        entityId: base.entityId,
        operationType: 'update',
        clientTimestamp: '2026-09-07T11:00:00.000Z',
      });
      const older = createOp({
        entityId: base.entityId,
        operationType: 'update',
        clientTimestamp: '2026-09-07T09:00:00.000Z',
      });

      // Two pushes, not one batch: [newer, older] is DESCENDING in
      // clientTimestamp, which §3.2 makes a protocol error — the server
      // cannot reorder, so it cannot repair it. Splitting at the
      // discontinuity is precisely what §3.2 tells a client to do, and an
      // earlier draft of this test got it wrong and was refused, correctly.
      const first = await push(patientA, [newer]);
      const second = await push(patientA, [older]);
      expect(first.body.results[0].status).toBe('accepted');
      expect(second.body.results[0].status).toBe('superseded');

      const losers = (await auditRows(base.entityId as string)).filter(
        (row) => row.reason_code === 'sync_conflict_loser',
      );
      // Exactly two conflicts were resolved, so exactly two losers were
      // preserved. Nothing a patient recorded is destroyed.
      expect(losers).toHaveLength(2);
    });

    it('carries the batch correlation id on every row the batch produced', async () => {
      const ops = [createOp(), createOp()];
      await push(patientA, ops).expect(200);

      const ids = new Set<unknown>();
      for (const op of ops) {
        for (const row of await auditRows(op.entityId as string)) {
          ids.add(row.correlation_id);
        }
      }

      // One id, shared — that is what makes "reconstruct which resolution
      // belonged to which push" answerable (ADR-0001).
      expect(ids.size).toBe(1);
      expect([...ids][0]).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe('§3.5 / §6.3 — what a rejection may carry', () => {
    it('stores only closed-set field values in sync_operations.rejection_field', async () => {
      // The test §3.5 owed this sprint. Storage is free text, the wire type
      // is closed, and §3.7 serves the byte-for-byte replay FROM these
      // columns — so a value outside the set would be replayed to a client
      // verbatim, forever.
      const cases: Array<Record<string, unknown>> = [
        { valueQuantity: { value: -1, unit: 'mL' } },
        { valueQuantity: { value: 0, unit: 'mL' } },
        { valueQuantity: { value: 'lots', unit: 'mL' } },
        { valueQuantity: { value: 123456789, unit: 'mL' } },
        { valueQuantity: { value: 350.12345, unit: 'mL' } },
        { effectiveDateTime: '2099-01-01T00:00:00.000Z' },
        { effectiveDateTime: '2020-01-01T00:00:00.000Z' },
        { status: 'amended' },
        { code: '11111-1' },
        { method: 'not-a-code' },
      ];

      const ops = cases.map((override) => {
        const op = createOp();
        Object.assign(op.payload as Record<string, unknown>, override);
        return op;
      });

      const response = await push(patientA, ops);
      const rejected = response.body.results.filter(
        (r: { status: string }) => r.status === 'rejected',
      );
      // Non-vacuity: if these all started passing, the assertion below would
      // hold over an empty set and prove nothing.
      expect(rejected.length).toBe(cases.length);

      const legalFields = new Set<string>(Object.values(SYNC_FIELD_PATH));
      for (const op of ops) {
        const row = await operationRow(op.operationId as string);
        expect(row).toBeDefined();
        expect(row!.status).toBe('REJECTED');
        expect(legalFields.has(row!.rejection_field as string)).toBe(true);
      }
      for (const result of rejected) {
        expect(legalFields.has(result.field as string)).toBe(true);
      }
    });

    it('never echoes the offending clinical value, in the result or the stored record', async () => {
      const op = createOp();
      (op.payload as Record<string, unknown>).valueQuantity = { value: -998877.5, unit: 'mL' };

      const response = await push(patientA, [op]);

      expect(response.body.results[0].status).toBe('rejected');
      expect(JSON.stringify(response.body)).not.toContain('998877');

      const row = await operationRow(op.operationId as string);
      expect(JSON.stringify(row)).not.toContain('998877');
    });

    /**
     * The closed-set test above is necessary and was not sufficient: it
     * asserts only that `rejection_field` is A member of `SYNC_FIELD_PATH`,
     * and `valueQuantity.value` is a member. Two of its ten cases were
     * mis-fielded and it passed anyway.
     *
     * `evaluateTier1` stamps its single `input.field` onto every error it
     * returns, so reading `error.field` directly reported the volume field
     * for rules about the method and the clinical date. §6.2 requires `field`
     * to name the offending field, and says why: "so two servers do not walk
     * one patient through different correction sequences for the same
     * payload" — which had become two ENDPOINTS in one server.
     */
    it.each([
      [
        'a clinical date before the surgery date',
        { effectiveDateTime: '2020-01-01T00:00:00.000Z' },
        'EFFECTIVE_DATE_TIME_BEFORE_SURGERY',
        'effectiveDateTime',
      ],
      [
        'a clinical date in the future',
        { effectiveDateTime: '2099-01-01T00:00:00.000Z' },
        'EFFECTIVE_DATE_TIME_IN_FUTURE',
        'effectiveDateTime',
      ],
      [
        'a negative volume',
        { valueQuantity: { value: -1, unit: 'mL' } },
        'VALUE_NOT_POSITIVE',
        'valueQuantity.value',
      ],
    ])('names the offending field for %s', async (_label, override, reasonCode, field) => {
      const op = createOp();
      Object.assign(op.payload as Record<string, unknown>, override);

      const response = await push(patientA, [op]);

      expect(response.body.results[0]).toMatchObject({ status: 'rejected', reasonCode, field });

      // And the stored record agrees — §3.7 replays the response from these
      // columns, so a wrong field there is wrong forever.
      const row = await operationRow(op.operationId as string);
      expect(row!.rejection_field).toBe(field);
      expect(row!.rejection_reason_code).toBe(reasonCode);
    });

    it('matches the direct endpoint exactly for a byte-identical payload', async () => {
      // The property §6.2 is protecting. Two surfaces over one table must not
      // walk a patient through two different correction sequences.
      const entityId = randomUUID();
      const body = payload({ id: entityId, effectiveDateTime: '2020-01-01T00:00:00.000Z' });

      const direct = await request(app.getHttpServer())
        .post('/api/v1/observations')
        .set('Authorization', `Bearer ${patientA.token}`)
        .send(body);

      const op = createOp({ entityId });
      Object.assign(op.payload as Record<string, unknown>, {
        effectiveDateTime: '2020-01-01T00:00:00.000Z',
      });
      const synced = await push(patientA, [op]);

      expect(direct.status).toBe(422);
      const directDetail = direct.body.error.errors[0];
      const syncedResult = synced.body.results[0];

      expect(syncedResult.reasonCode).toBe(directDetail.reasonCode);
      expect(syncedResult.field).toBe(directDetail.field);
    });

    /**
     * §3.7 applies to rejections too, and three paths used to skip the
     * idempotency record entirely — so a re-push returned `replayed: false`
     * and, worse, was re-evaluated against live state.
     */
    it.each([
      [
        'ENTITY_NOT_FOUND on an update',
        async (): Promise<Record<string, unknown>> =>
          createOp({ entityId: randomUUID(), operationType: 'update' }),
      ],
      [
        'a cross-patient entity id, which is treated as not existing',
        async (): Promise<Record<string, unknown>> => {
          const theirs = createOp();
          await push(patientB, [theirs]).expect(200);
          return createOp({ entityId: theirs.entityId, operationType: 'update' });
        },
      ],
    ])('records and replays a rejection from %s', async (_label, build) => {
      const op = await build();

      const first = await push(patientA, [op]);
      expect(first.body.results[0].status).toBe('rejected');
      expect(first.body.results[0].replayed).toBe(false);

      const second = await push(patientA, [op]);
      expect(second.body.results[0]).toEqual({ ...first.body.results[0], replayed: true });

      // The record exists, which is what makes the replay possible and what
      // stops a redelivery being re-evaluated against changed state.
      const row = await operationRow(op.operationId as string);
      expect(row).toBeDefined();
      expect(row!.status).toBe('REJECTED');
    });

    it('does not apply an operation on re-push that was rejected as not-found before its create landed', async () => {
      // The concrete consequence of the missing record. An update arrives
      // before the create (reordered delivery, a split batch); it is refused.
      // The create then lands. A redelivery of the SAME operationId must
      // still be a rejection — not an apply carrying the original stale
      // clientTimestamp into a comparison the server already declined.
      const entityId = randomUUID();
      const update = createOp({
        entityId,
        operationType: 'update',
        clientTimestamp: '2026-09-07T08:00:00.000Z',
      });

      const refused = await push(patientA, [update]);
      expect(refused.body.results[0]).toMatchObject({
        status: 'rejected',
        reasonCode: 'ENTITY_NOT_FOUND',
      });

      await push(patientA, [
        createOp({ entityId, clientTimestamp: '2026-09-07T12:00:00.000Z' }),
      ]).expect(200);
      const afterCreate = Number((await observationRows(entityId))[0]!.value_quantity_value);

      const redelivered = await push(patientA, [update]);

      expect(redelivered.body.results[0]).toMatchObject({
        status: 'rejected',
        reasonCode: 'ENTITY_NOT_FOUND',
        replayed: true,
      });
      // The row is untouched: the stale operation did not win a conflict it
      // was never allowed to enter.
      expect(Number((await observationRows(entityId))[0]!.value_quantity_value)).toBe(afterCreate);
    });

    it('rejects a clock timestamp beyond the allowance, naming clientTimestamp', async () => {
      // §3.8: a poisoned timestamp. Because conflict resolution is
      // last-write-wins by client timestamp, a device with a clock set to
      // 2031 wins every conflict against every other device, permanently.
      const future = new Date(Date.now() + (CLOCK_SKEW_SECONDS + 600) * 1000);
      const op = createOp({ clientTimestamp: future.toISOString() });

      const response = await push(patientA, [op]);

      expect(response.body.results[0]).toMatchObject({
        status: 'rejected',
        reasonCode: 'CLIENT_TIMESTAMP_OUT_OF_RANGE',
        field: 'clientTimestamp',
      });
      expect(await observationRows(op.entityId as string)).toHaveLength(0);
    });
  });
  describe('§2 — every lookup is scoped to (patient, entityId) together', () => {
    it('refuses an entity id belonging to another patient, without revealing that it exists', async () => {
      const mine = createOp();
      await push(patientB, [mine]).expect(200);

      const steal = createOp({
        entityId: mine.entityId,
        operationType: 'update',
        clientTimestamp: '2026-09-08T10:00:00.000Z',
      });
      const response = await push(patientA, [steal]);

      // §2/§4 as corrected at P2.S1b: byte-identical to an id that exists for
      // nobody. A distinct code would be the disclosure §2 forbids.
      expect(response.body.results[0]).toMatchObject({
        status: 'rejected',
        reasonCode: 'ENTITY_NOT_FOUND',
        field: 'entityId',
      });

      // B's row is untouched and still B's. `Observation.id` is a global
      // primary key, so `update({ where: { id } })` compiles and would have
      // let A overwrite it given the UUID.
      const rows = await observationRows(mine.entityId as string);
      expect(rows[0]!.patient_id).toBe(patientB.patientId);
      expect(Number(rows[0]!.value_quantity_value)).toBe(350.5);

      // And the refusal is byte-identical to one for an id that exists for
      // nobody — which is the whole control. Any difference here, including a
      // different reason code, is an oracle: an authenticated patient could
      // tell "someone else has this UUID" from "no such row".
      const nonexistent = await push(patientA, [
        createOp({
          entityId: randomUUID(),
          operationType: 'update',
          clientTimestamp: '2026-09-08T10:00:00.000Z',
        }),
      ]);
      const { operationId: _a, entityId: _b, ...foreignResult } = response.body.results[0];
      const { operationId: _c, entityId: _d, ...missingResult } = nonexistent.body.results[0];
      expect(foreignResult).toEqual(missingResult);
    });

    it('reports ENTITY_NOT_FOUND for an id that exists for nobody', async () => {
      const update = createOp({
        entityId: randomUUID(),
        operationType: 'update',
      });
      const response = await push(patientA, [update]);

      expect(response.body.results[0]).toMatchObject({
        status: 'rejected',
        reasonCode: 'ENTITY_NOT_FOUND',
        field: 'entityId',
      });
    });

    it('does not treat a tombstoned row as not-found — §4 keeps it existing for update and delete', async () => {
      const create = createOp({ clientTimestamp: '2026-09-07T08:00:00.000Z' });
      await push(patientA, [create]).expect(200);
      await push(patientA, [
        {
          operationId: randomUUID(),
          entityType: 'Observation',
          entityId: create.entityId,
          operationType: 'delete',
          clientTimestamp: '2026-09-07T09:00:00.000Z',
        },
      ]).expect(200);

      const update = createOp({
        entityId: create.entityId,
        operationType: 'update',
        clientTimestamp: '2026-09-07T10:00:00.000Z',
      });
      const response = await push(patientA, [update]);

      // An implementer who applies ADR-0001's "filter tombstones from every
      // read path" here returns ENTITY_NOT_FOUND for exactly the operation
      // §4's resurrection rule says must succeed.
      expect(response.body.results[0].status).toBe('accepted');
    });
  });

  describe('§6.1 — protocol errors fail the whole request with a code and nothing else', () => {
    function expectProtocolBody(body: unknown, code: string): void {
      // The only keys are `error` -> `code`. No prose, no field path, no
      // echoed request content, no index into the offending operation.
      expect(body).toEqual({ error: { code } });
      expect(Object.keys(body as object)).toEqual(['error']);
      expect(Object.keys((body as { error: object }).error)).toEqual(['code']);
    }

    it('MALFORMED_REQUEST for an unrecognized key at the operation level', async () => {
      const op = createOp();
      (op as Record<string, unknown>).patientId = patientB.patientId;

      const response = await push(patientA, [op]);

      expect(response.status).toBe(400);
      expectProtocolBody(response.body, 'MALFORMED_REQUEST');
      // §2: the absence of the field is the control. Nothing was applied.
      expect(await observationRows(op.entityId as string)).toHaveLength(0);
    });

    it('MALFORMED_REQUEST for malformed JSON, without echoing the body', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/sync/push')
        .set('Authorization', `Bearer ${patientA.token}`)
        .set('Content-Type', 'application/json')
        .send('{"operations":[{"valueQuantity":{"value":4471.25q}}]}');

      expect(response.status).toBe(400);
      expectProtocolBody(response.body, 'MALFORMED_REQUEST');
      expect(JSON.stringify(response.body)).not.toContain('4471');
    });

    it('MALFORMED_REQUEST for an unknown entityType', async () => {
      const response = await push(patientA, [createOp({ entityType: 'Sasquatch' })]);
      expect(response.status).toBe(400);
      expectProtocolBody(response.body, 'MALFORMED_REQUEST');
    });

    it('BATCH_OUT_OF_ORDER for a descending clientTimestamp array', async () => {
      const response = await push(patientA, [
        createOp({ clientTimestamp: '2026-09-07T12:00:00.000Z' }),
        createOp({ clientTimestamp: '2026-09-07T09:00:00.000Z' }),
      ]);

      expect(response.status).toBe(400);
      expectProtocolBody(response.body, 'BATCH_OUT_OF_ORDER');
    });

    it('accepts equal timestamps, which are permitted and resolved by array order', async () => {
      const at = '2026-09-07T12:00:00.000Z';
      const response = await push(patientA, [
        createOp({ clientTimestamp: at }),
        createOp({ clientTimestamp: at }),
      ]);
      expect(response.status).toBe(200);
    });

    it('PAYLOAD_PRESENCE_INVALID for a payload on a delete, and for one missing on a create', async () => {
      const withPayload = await push(patientA, [
        createOp({ operationType: 'delete', payload: payload({ id: randomUUID() }) }),
      ]);
      expect(withPayload.status).toBe(400);
      expectProtocolBody(withPayload.body, 'PAYLOAD_PRESENCE_INVALID');

      const op = createOp();
      delete (op as Record<string, unknown>).payload;
      const withoutPayload = await push(patientA, [op]);
      expect(withoutPayload.status).toBe(400);
      expectProtocolBody(withoutPayload.body, 'PAYLOAD_PRESENCE_INVALID');
    });

    it('ENTITY_ID_MISMATCH when payload.id does not equal the operation entityId', async () => {
      const op = createOp();
      (op.payload as Record<string, unknown>).id = randomUUID();

      const response = await push(patientA, [op]);
      expect(response.status).toBe(400);
      expectProtocolBody(response.body, 'ENTITY_ID_MISMATCH');
    });

    it('BATCH_TOO_LARGE above SYNC_PUSH_MAX_OPERATIONS', async () => {
      const at = '2026-09-07T12:00:00.000Z';
      const operations = Array.from({ length: 501 }, () => createOp({ clientTimestamp: at }));

      const response = await push(patientA, operations);

      expect(response.status).toBe(413);
      expectProtocolBody(response.body, 'BATCH_TOO_LARGE');
      // §6.1: a protocol error applies NO operations.
      expect(await observationRows(operations[0]!.entityId as string)).toHaveLength(0);
    });

    it('UNAUTHENTICATED for a missing token, collapsing the guard AUTH_* vocabulary', async () => {
      // The §6.1 decision this sprint owed: the contract is the artifact two
      // independent implementations read, and it says UNAUTHENTICATED. The
      // guard keeps AUTH_MISSING_TOKEN everywhere else.
      const response = await request(app.getHttpServer())
        .post('/api/v1/sync/push')
        .send({ operations: [] });

      expect(response.status).toBe(401);
      expectProtocolBody(response.body, 'UNAUTHENTICATED');
      expect(JSON.stringify(response.body)).not.toContain('AUTH_MISSING_TOKEN');
    });

    it('MALFORMED_REQUEST for a missing or non-numeric since on delta', async () => {
      const missing = await request(app.getHttpServer())
        .get('/api/v1/sync/delta')
        .set('Authorization', `Bearer ${patientA.token}`);
      expect(missing.status).toBe(400);
      expectProtocolBody(missing.body, 'MALFORMED_REQUEST');

      const nonNumeric = await delta(patientA, { since: 'yesterday' });
      expect(nonNumeric.status).toBe(400);
      expectProtocolBody(nonNumeric.body, 'MALFORMED_REQUEST');
    });
  });

  describe('§5 — delta', () => {
    it('returns changes ordered by serverSequence with FHIR payloads, and advances the cursor', async () => {
      const fresh = await seedPatient();
      const at = '2026-09-07T12:00:00.000Z';
      const ops = [createOp({ clientTimestamp: at }), createOp({ clientTimestamp: at })];
      await push(fresh, ops).expect(200);

      const response = await delta(fresh, { since: 0 });

      expect(response.status).toBe(200);
      expect(response.body.changes).toHaveLength(2);
      expect(response.body.hasMore).toBe(false);

      const sequences = response.body.changes.map((c: { serverSequence: string }) =>
        BigInt(c.serverSequence),
      );
      expect(sequences[1]).toBeGreaterThan(sequences[0]);
      // §7.3: server sequences are JSON STRINGS, not numbers — they are
      // 64-bit and JSON.parse loses precision above 2^53.
      expect(typeof response.body.changes[0].serverSequence).toBe('string');
      expect(typeof response.body.cursor).toBe('string');
      expect(response.body.cursor).toBe(String(sequences[1]));

      // AC 2.5 AC1: FHIR field names on the wire.
      expect(response.body.changes[0].payload).toMatchObject({
        resourceType: 'Observation',
        status: 'final',
        code: STOMA_OUTPUT_CODE,
        valueQuantity: { value: 350.5, unit: 'mL' },
        // ADR-0018 (amended): the delta republishes what was STORED, so a
        // measured entry comes back as the explicit qualifier even when the
        // push that created it sent `null`. A second device therefore never
        // has to re-derive the toggle from `code`.
        method: '258104002',
        enteredMeasurementSystem: 'metric',
        enteredTimezone: 'America/Chicago',
      });
      expect(response.body.changes[0].deleted).toBe(false);
    });

    it('sends a tombstone with no payload at all', async () => {
      const fresh = await seedPatient();
      const create = createOp({ clientTimestamp: '2026-09-07T08:00:00.000Z' });
      await push(fresh, [create]).expect(200);
      await push(fresh, [
        {
          operationId: randomUUID(),
          entityType: 'Observation',
          entityId: create.entityId,
          operationType: 'delete',
          clientTimestamp: '2026-09-07T09:00:00.000Z',
        },
      ]).expect(200);

      const response = await delta(fresh, { since: 0 });
      const change = response.body.changes.find(
        (c: { entityId: string }) => c.entityId === create.entityId,
      );

      expect(change.deleted).toBe(true);
      // Not an empty payload — no key at all. Sending the clinical values of
      // a deleted entry would transmit PHI that serves no purpose (§5.2).
      expect('payload' in change).toBe(false);
      expect(JSON.stringify(change)).not.toContain('350.5');
      // §5.2: a tombstone's clientUpdatedAt is the DELETING operation's
      // client timestamp, so a device holding an unpushed local edit can
      // resolve it by the same rule the server applies.
      expect(change.clientUpdatedAt).toBe('2026-09-07T09:00:00.000Z');
    });

    it('pages, and hasMore is about the page rather than the high-water mark', async () => {
      const fresh = await seedPatient();
      const at = '2026-09-07T12:00:00.000Z';
      await push(
        fresh,
        Array.from({ length: 3 }, () => createOp({ clientTimestamp: at })),
      ).expect(200);

      const first = await delta(fresh, { since: 0, limit: 2 });
      expect(first.body.changes).toHaveLength(2);
      expect(first.body.hasMore).toBe(true);

      const second = await delta(fresh, { since: first.body.cursor, limit: 2 });
      expect(second.body.changes).toHaveLength(1);
      expect(second.body.hasMore).toBe(false);

      const third = await delta(fresh, { since: second.body.cursor, limit: 2 });
      expect(third.body.changes).toHaveLength(0);
      // MUST be false whenever changes is empty — otherwise the client spins
      // in a tight loop against the API (§5.2).
      expect(third.body.hasMore).toBe(false);
    });

    it('clamps a limit above the maximum rather than refusing it', async () => {
      // §5.1: a 400 here would permanently brick any fielded client whose
      // hardcoded page size the server later lowered.
      const response = await delta(patientA, { since: 0, limit: 999999 });
      expect(response.status).toBe(200);
    });

    it('echoes since unchanged when it is higher than anything the server holds', async () => {
      // Reachable through a device restore, a dev-reset, or a restore from
      // backup. Returning the server maximum would move the cursor BACKWARDS
      // into rows already applied; returning "0" would silently re-download
      // the patient's entire history over cellular (§5.1).
      const response = await delta(patientA, { since: '999999999' });

      expect(response.status).toBe(200);
      expect(response.body.changes).toEqual([]);
      expect(response.body.hasMore).toBe(false);
      expect(response.body.cursor).toBe('999999999');
    });

    it('never returns another patient rows', async () => {
      const fresh = await seedPatient();
      const mine = createOp();
      await push(fresh, [mine]).expect(200);

      const otherView = await delta(patientA, { since: 0 });
      const ids = otherView.body.changes.map((c: { entityId: string }) => c.entityId);
      expect(ids).not.toContain(mine.entityId);
    });
  });
  /**
   * §5.3's normative invariant: *if a client's cursor is `C`, the client has
   * been shown every change for that patient with server sequence ≤ `C`.*
   *
   * §5.3 is explicit that this does not hold for free, and requires this
   * sprint to "prove it with a test that interleaves two concurrent writes
   * and commits them out of order." That is what this block does.
   *
   * The rows are inserted through raw SQL rather than the push endpoint
   * deliberately: the hazard is a property of the delta READ path, and
   * reproducing it needs a transaction held open across a second one, which
   * an HTTP request cannot do.
   */
  describe('§5.3 — the cursor guarantee under out-of-order commits', () => {
    async function insertObservationInTransaction(
      client: PgClient,
      patientId: string,
      entityId: string,
    ): Promise<void> {
      await client.query(
        `INSERT INTO observations
           (id, patient_id, resource_type, code, value_quantity_value, value_quantity_unit,
            effective_datetime, status, entered_measurement_system, entered_timezone, local_date,
            client_updated_at, updated_at)
         VALUES ($1, $2, 'Observation', $3, 350.5, 'mL',
            TIMESTAMPTZ '2026-09-07T14:00:00.000Z', 'final', 'METRIC', 'America/Chicago',
            DATE '2026-09-07', now(), now())`,
        [entityId, patientId, STOMA_OUTPUT_CODE],
      );
    }

    it('withholds a committed row whose lower-sequenced sibling is still in flight, then releases both in order', async () => {
      const fresh = await seedPatient();
      const earlyId = randomUUID();
      const lateId = randomUUID();

      const slow = new PgClient({ connectionString: runtimeDatabaseUrl });
      const fast = new PgClient({ connectionString: runtimeDatabaseUrl });
      await slow.connect();
      await fast.connect();

      try {
        // A takes the LOWER sequence and does not commit.
        await slow.query('BEGIN');
        await insertObservationInTransaction(slow, fresh.patientId, earlyId);

        // B takes the HIGHER sequence and commits first. This is the
        // out-of-order commit: sequence order and commit order now disagree.
        await fast.query('BEGIN');
        await insertObservationInTransaction(fast, fresh.patientId, lateId);
        await fast.query('COMMIT');

        // What a naive `ORDER BY server_sequence` would serve: B alone. The
        // client would persist B's sequence as its cursor, never ask for
        // anything lower again, and A's row would be permanently invisible to
        // that device — with no error, no retry, and no way for either side to
        // detect it afterwards.
        const naive = await db.query(
          `SELECT id FROM observations WHERE patient_id = $1 ORDER BY server_sequence ASC`,
          [fresh.patientId],
        );
        expect(naive.rows.map((row) => row.id)).toEqual([lateId]);

        // What the endpoint actually serves: nothing. The in-flight window is
        // withheld, so no cursor is issued that would skip A.
        const duringFlight = await delta(fresh, { since: 0 });
        expect(duringFlight.status).toBe(200);
        expect(duringFlight.body.changes).toEqual([]);
        expect(duringFlight.body.hasMore).toBe(false);
        // The cursor did not advance past anything, so a client re-polling
        // asks for the same window again rather than skipping ahead.
        expect(duringFlight.body.cursor).toBe('0');

        await slow.query('COMMIT');

        // Once A commits, BOTH become visible, in sequence order — A first,
        // which is the row the naive query had already skipped past.
        const afterCommit = await delta(fresh, { since: 0 });
        expect(afterCommit.body.changes.map((c: { entityId: string }) => c.entityId)).toEqual([
          earlyId,
          lateId,
        ]);
        const sequences = afterCommit.body.changes.map((c: { serverSequence: string }) =>
          BigInt(c.serverSequence),
        );
        expect(sequences[0]).toBeLessThan(sequences[1]);
        expect(afterCommit.body.cursor).toBe(String(sequences[1]));
      } finally {
        // `ROLLBACK` after a successful `COMMIT` is a no-op warning, not an
        // error — safe on both the pass and fail paths.
        await slow.query('ROLLBACK').catch(() => undefined);
        await fast.query('ROLLBACK').catch(() => undefined);
        await slow.end();
        await fast.end();
      }
    });

    it('never issues a cursor that skips a row, across a paged pull with concurrent writers', async () => {
      // The same invariant stated as the client sees it: every row the
      // patient has must appear exactly once across a full pull loop, with no
      // gap, even though a writer is committing throughout.
      const fresh = await seedPatient();
      const at = '2026-09-07T12:00:00.000Z';
      const ops = Array.from({ length: 5 }, () => createOp({ clientTimestamp: at }));
      await push(fresh, ops).expect(200);

      const seen: string[] = [];
      let cursor = '0';
      for (let page = 0; page < 10; page += 1) {
        const response = await delta(fresh, { since: cursor, limit: 2 });
        for (const change of response.body.changes as Array<{ entityId: string }>) {
          seen.push(change.entityId);
        }
        cursor = response.body.cursor;
        if (!response.body.hasMore) break;
      }

      // Every entity, exactly once, and nothing else.
      expect(seen.sort()).toEqual(ops.map((op) => op.entityId as string).sort());
      expect(new Set(seen).size).toBe(seen.length);
    });

    /**
     * The mechanism the fix depends on, pinned on its own.
     *
     * This does not go through the endpoint — it demonstrates the PostgreSQL
     * behaviour `SyncDeltaService` relies on, so a future reader can see what
     * the `RepeatableRead` transaction is actually for. Deterministic: the
     * concurrent update commits between two reads that are explicitly
     * sequenced.
     *
     * Under READ COMMITTED the two reads disagree, which is exactly how the
     * cursor came to be taken from a different database state than the page.
     */
    it.each([
      ['READ COMMITTED', 'READ COMMITTED', true],
      ['REPEATABLE READ', 'REPEATABLE READ', false],
    ])(
      'under %s, a committed update between two reads is visible to the second: %s',
      async (_label, isolation, expectDisagreement) => {
        const fresh = await seedPatient();
        const entityId = randomUUID();
        await db.query(
          `INSERT INTO observations
             (id, patient_id, resource_type, code, value_quantity_value, value_quantity_unit,
              effective_datetime, status, entered_measurement_system, entered_timezone, local_date,
              client_updated_at, updated_at)
           VALUES ($1, $2, 'Observation', $3, 350.5, 'mL',
              TIMESTAMPTZ '2026-09-07T14:00:00.000Z', 'final', 'METRIC', 'America/Chicago',
              DATE '2026-09-07', now(), now())`,
          [entityId, fresh.patientId, STOMA_OUTPUT_CODE],
        );

        const reader = new PgClient({ connectionString: runtimeDatabaseUrl });
        const writer = new PgClient({ connectionString: runtimeDatabaseUrl });
        await reader.connect();
        await writer.connect();

        try {
          await reader.query(`BEGIN ISOLATION LEVEL ${isolation}`);
          const first = await reader.query(
            `SELECT server_sequence FROM observations WHERE id = $1`,
            [entityId],
          );

          // The trigger is BEFORE INSERT OR UPDATE, so this re-stamps
          // server_sequence — which is why an update, not just an insert,
          // can move a row out from under a paged read.
          await writer.query(`UPDATE observations SET value_quantity_value = 999 WHERE id = $1`, [
            entityId,
          ]);

          const second = await reader.query(
            `SELECT server_sequence FROM observations WHERE id = $1`,
            [entityId],
          );

          const disagreed =
            String(first.rows[0].server_sequence) !== String(second.rows[0].server_sequence);
          expect(disagreed).toBe(expectDisagreement);
        } finally {
          await reader.query('ROLLBACK').catch(() => undefined);
          await reader.end();
          await writer.end();
        }
      },
    );

    /**
     * The end-to-end invariant, under a writer committing throughout.
     *
     * This is the test that catches the defect both reviewers found: the
     * `xmin` predicate alone does not hold §5.3, because the cursor used to
     * be derived from a second, unsynchronized read. With the two reads
     * outside one snapshot this fails — an entity gets skipped and never
     * reappears, because the cursor advanced past it.
     *
     * Repeated, because hitting the window is a race rather than something
     * the test can sequence from outside the service. It cannot fail in the
     * other direction: with the reads in one snapshot the invariant holds
     * unconditionally, so a passing run is not luck.
     */
    it('never skips a row when an update commits during a paged pull', async () => {
      const at = '2026-09-07T12:00:00.000Z';
      const writer = new PgClient({ connectionString: runtimeDatabaseUrl });
      await writer.connect();

      try {
        for (let attempt = 0; attempt < 6; attempt += 1) {
          // A fresh patient per attempt. The rate limit is keyed per patient
          // (§2), and a paged pull under churn legitimately takes many
          // requests — reusing one patient across attempts trips the limit
          // rather than the invariant, which would make this test fail for a
          // reason that has nothing to do with what it checks.
          const fresh = await seedPatient();
          const ops = Array.from({ length: 12 }, () => createOp({ clientTimestamp: at }));
          await push(fresh, ops).expect(200);
          const allIds = ops.map((op) => op.entityId as string);

          let churning = true;

          // A writer re-stamping sequences CONTINUOUSLY for the whole
          // duration of the pull, not a fixed burst. The window this has to
          // land in is between the delta query's two statements, which is
          // sub-millisecond — a few updates never hit it, and a test that
          // does not hit it passes against the defect and proves nothing.
          // (Verified: an earlier burst-of-four version passed with the
          // isolation level downgraded.)
          const churn = (async () => {
            while (churning) {
              await writer.query(
                `UPDATE observations SET value_quantity_value = value_quantity_value + 1
                 WHERE id = $1`,
                [allIds[Math.floor(Math.random() * allIds.length)]],
              );
            }
          })();

          const seen: string[] = [];
          let cursor = '0';
          // Generous bound: churn moves rows to new sequences, so a full pull
          // legitimately takes more pages than there are rows.
          for (let page = 0; page < 60; page += 1) {
            const response = await delta(fresh, { since: cursor, limit: 2 });
            expect(response.status).toBe(200);
            for (const change of response.body.changes as Array<{ entityId: string }>) {
              seen.push(change.entityId);
            }
            cursor = response.body.cursor;
            if (!response.body.hasMore) break;
          }

          churning = false;
          await churn;

          // Every entity this patient has must have been served at least
          // once. A skipped row is invisible to that device forever — §5.3's
          // invariant, stated as the client experiences it.
          const missing = allIds.filter((id) => !seen.includes(id));
          expect(missing).toEqual([]);
        }
      } finally {
        await writer.end();
      }
    });
  });
  /**
   * The generated typed client, exercised against the running API.
   *
   * `packages/core/src/api-client` is what `apps/mobile` (P2.S2) compiles
   * against, and it is the only consumer of this protocol. It shipped
   * unusable — `SyncController` carried only `@ApiOperation`, so the
   * generator emitted `push(): Promise<void>` (no body, no results) and
   * `delta(): Promise<void>` (no way to pass the required `since`).
   *
   * Nothing caught it. The stale-client check proves the client matches the
   * document; the document was faithfully describing an under-annotated
   * controller. So this block exercises the client the way a client author
   * would — if the annotations regress, these stop compiling or stop
   * returning data, rather than silently emitting a `void` method again.
   */
  describe('the generated typed client speaks this protocol', () => {
    it('pushes a batch and reads the results back, typed', async () => {
      const fresh = await seedPatient();
      const client = createApiClient({
        baseUrl,
        getAccessToken: () => fresh.token,
      });

      const entityId = randomUUID();
      const response = await client.sync.push({
        operations: [
          {
            operationId: randomUUID(),
            entityType: 'Observation',
            entityId,
            operationType: 'create',
            clientTimestamp: '2026-09-07T22:04:11.412Z',
            payload: {
              resourceType: 'Observation',
              id: entityId,
              status: 'final',
              code: STOMA_OUTPUT_CODE,
              valueQuantity: { value: 350.5, unit: 'mL' },
              effectiveDateTime: '2026-09-07T14:00:00.000Z',
              method: null,
              enteredMeasurementSystem: 'metric',
              enteredTimezone: 'America/Chicago',
            },
          },
        ],
      });

      // Typed all the way through: `results` exists, is an array, and carries
      // the discriminated fields. Under the old emission this was `void` and
      // the next line would not have compiled.
      expect(response.results).toHaveLength(1);
      expect(response.results[0]!.status).toBe('accepted');
      expect(response.results[0]!.entityId).toBe(entityId);
      expect(typeof response.results[0]!.appliedServerSequence).toBe('string');
      expect(response.results[0]!.replayed).toBe(false);
    });

    it('pulls a delta page, with since required by the type', async () => {
      const fresh = await seedPatient();
      const op = createOp();
      await push(fresh, [op]).expect(200);

      const client = createApiClient({ baseUrl, getAccessToken: () => fresh.token });

      // `since` is required on `SyncDeltaQuery`, and the query bag itself is
      // required because of it — `client.sync.delta()` does not compile.
      const page = await client.sync.delta({ since: '0' });

      expect(page.changes).toHaveLength(1);
      expect(page.changes[0]!.entityId).toBe(op.entityId);
      expect(page.changes[0]!.deleted).toBe(false);
      expect(typeof page.cursor).toBe('string');
      expect(page.hasMore).toBe(false);
      // §7.3: a string, so a 64-bit sequence survives JSON.parse.
      expect(typeof page.changes[0]!.serverSequence).toBe('string');
    });

    it('surfaces a protocol error as a typed ApiError a client can route on', async () => {
      const fresh = await seedPatient();
      const client = createApiClient({ baseUrl, getAccessToken: () => fresh.token });

      const error = await client.sync.delta({ since: 'not-a-number' }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.status).toBe(400);
      expect(apiError.rejectionForCorrectionQueue()).toEqual({
        error: { code: 'MALFORMED_REQUEST' },
      });
      // §6.3 applies here as it does everywhere: nothing derived from the
      // request reaches a serialized error.
      expect(JSON.stringify(apiError)).not.toContain('not-a-number');
    });
  });
  /**
   * §2: *"Both endpoints are rate-limited, and a `since=0` delta pull is
   * recorded in the security log."* Those two sit in one sentence for a
   * reason — a `since=0` pull returns a patient's entire clinical history
   * and is what a stolen token is worth, so the limit bounds how fast that
   * can happen and the log makes it visible afterwards.
   */
  describe('§2 — rate limiting and the security log', () => {
    it('refuses a patient who exceeds the window, with 429', async () => {
      const fresh = await seedPatient();

      let limited = 0;
      let lastStatus = 0;
      // Comfortably past the limit. Sequential, because the point is the
      // per-patient budget rather than concurrency behaviour.
      for (let i = 0; i < SYNC_THROTTLE.limit + 5; i += 1) {
        const response = await delta(fresh, { since: 0 });
        lastStatus = response.status;
        if (response.status === 429) limited += 1;
      }

      expect(limited).toBeGreaterThan(0);
      expect(lastStatus).toBe(429);
    });

    it('keys the limit on the patient, not the connection', async () => {
      // Mobile clients share carrier NAT. An IP-keyed limit would throttle
      // unrelated patients together, which is both a correctness problem and
      // the reason a useful limit would be impossible to set.
      const heavy = await seedPatient();
      for (let i = 0; i < SYNC_THROTTLE.limit + 2; i += 1) {
        await delta(heavy, { since: 0 });
      }
      expect((await delta(heavy, { since: 0 })).status).toBe(429);

      // Same process, same connection, different patient: unaffected.
      const bystander = await seedPatient();
      expect((await delta(bystander, { since: 0 })).status).toBe(200);
    });

    it('records a since=0 pull to the security log, and an incremental pull not at all', async () => {
      const fresh = await seedPatient();
      const op = createOp();
      await push(fresh, [op]).expect(200);

      const lines: string[] = [];
      const spy = vi.spyOn(NestLogger.prototype, 'log').mockImplementation((message: unknown) => {
        lines.push(String(message));
      });

      try {
        const full = await delta(fresh, { since: 0 });
        expect(full.status).toBe(200);

        const recorded = lines.filter((line) => line.includes('sync.delta.full_history_pull'));
        expect(recorded).toHaveLength(1);

        const event = JSON.parse(recorded[0]!) as Record<string, unknown>;
        expect(event.actorSubject).toBe(fresh.subject);
        expect(event.patientId).toBe(fresh.patientId);
        // Who and when, never what. A security log line carries no clinical
        // value — the volume this patient logged is not in it.
        expect(recorded[0]).not.toContain('350.5');

        // An incremental pull is ordinary use and is not recorded; otherwise
        // the signal is buried in every poll every client makes.
        lines.length = 0;
        await delta(fresh, { since: full.body.cursor });
        expect(lines.filter((l) => l.includes('sync.delta.full_history_pull'))).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });

    it('records a cross-patient entity probe, which the client is told nothing about', async () => {
      const owner = await seedPatient();
      const prober = await seedPatient();
      const theirs = createOp();
      await push(owner, [theirs]).expect(200);

      const lines: string[] = [];
      const spy = vi.spyOn(NestLogger.prototype, 'warn').mockImplementation((message: unknown) => {
        lines.push(String(message));
      });

      try {
        const response = await push(prober, [
          createOp({
            entityId: theirs.entityId,
            operationType: 'update',
            clientTimestamp: '2026-09-08T10:00:00.000Z',
          }),
        ]);

        // The client learns only that no such entity exists (§2).
        expect(response.body.results[0]).toMatchObject({
          status: 'rejected',
          reasonCode: 'ENTITY_NOT_FOUND',
        });

        // The operator sees the attempt. That asymmetry is the whole design:
        // the probe learns nothing and the event is still recorded.
        const recorded = lines.filter((line) => line.includes('sync.push.cross_patient_entity'));
        expect(recorded).toHaveLength(1);
        const event = JSON.parse(recorded[0]!) as Record<string, unknown>;
        expect(event.actorSubject).toBe(prober.subject);
        expect(event.entityId).toBe(theirs.entityId);
        // The owner is NOT named — knowing someone else holds the id is the
        // disclosure this whole change removes, and it does not belong in a
        // log line either.
        expect(recorded[0]).not.toContain(owner.patientId);
        expect(recorded[0]).not.toContain(owner.subject);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
