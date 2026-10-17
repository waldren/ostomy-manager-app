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
 * Quick-Add decisions through sync (P4.S3 slice 5, `docs/sync-contract.md`
 * §7.7, SRS §3.10, Epic 15 story 3): pin, hide, or undo a decision about one
 * widget, on one device, and see it on the others.
 *
 * Against real PostgreSQL through the real HTTP stack, because the rules are
 * about rows: one row per widget whichever device decides, last-write-wins on
 * it, and an audit row for every write.
 */

import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { quickAddPreferenceId, type QuickAddRoutine } from '@ostomy/core/sync';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';
import { PATIENT_JWKS_RESOLVER } from '../auth/patient-jwks-resolver.token';
import type { AppConfig } from '../config/env.schema';
import { createTestOidcIssuer, type TestOidcIssuer } from '../test-support/oidc-test-tokens';

import { QUICK_ADD_ENTITY_TYPE, quickAddLockKey } from './quick-add-payload';

const API_ROOT = path.resolve(__dirname, '..', '..');
const ISSUER = 'https://issuer.test/patient';
const AUDIENCE = 'ostomy-patient-app';
const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'quick-add-sync-integration-test-only-password';

const MEASURED = '258104002';
const ESTIMATED = '414135002';

/** A stoma-output routine: 350 mL, measured, entered in millilitres. */
const ROUTINE: QuickAddRoutine = {
  code: '79560-9',
  valueMl: 350,
  method: MEASURED,
  fluidTypeCode: null,
  urineColorCode: null,
  enteredMeasurementSystem: 'metric',
};

interface Patient {
  readonly patientId: string;
  readonly profileId: string;
  readonly token: string;
}

const sha1 = (input: Uint8Array) => new Uint8Array(createHash('sha1').update(input).digest());

describe('P4.S3 — Quick-Add decisions through sync', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let db: PgClient;
  let issuer: TestOidcIssuer;
  let runtimeDatabaseUrl: string;

  function testConfig(): AppConfig {
    return {
      nodeEnv: 'test',
      port: 0,
      logLevel: 'silent',
      oidcClockToleranceSeconds: 30,
      corsAllowedOrigins: [],
      syncPushMaxOperations: 500,
      syncDeltaDefaultLimit: 200,
      syncDeltaMaxLimit: 1000,
      databaseUrl: runtimeDatabaseUrl,
      oidc: {
        issuer: ISSUER,
        jwksUri: `${ISSUER}/jwks`,
        audience: AUDIENCE,
        claimMapping: { subjectClaim: 'sub' },
      },
      adminOidc: {
        issuer: 'https://mock-oidc.test/admin-issuer',
        jwksUri: 'https://mock-oidc.test/admin-issuer/jwks',
        audience: 'ostomy-admin-console',
        claimMapping: { subjectClaim: 'sub' },
      },
      objectStorage: {
        endpoint: 'http://localhost:9000',
        region: 'us-east-1',
        accessKeyId: 'test-access-key',
        secretAccessKey: 'test-secret-key',
        forcePathStyle: true,
      },
    };
  }

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('ostomy_quick_add_sync_test')
      .withUsername('ostomy_owner')
      .withPassword('owner-test-only-password')
      .start();

    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        cwd: API_ROOT,
        env: { ...process.env, MIGRATION_DATABASE_URL: container.getConnectionUri() },
        stdio: 'pipe',
      },
    );

    const owner = new PgClient({ connectionString: container.getConnectionUri() });
    await owner.connect();
    try {
      await owner.query(`ALTER ROLE "${RUNTIME_ROLE}" WITH LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
    } finally {
      await owner.end();
    }

    runtimeDatabaseUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@${container.getHost()}:${container.getMappedPort(5432)}/${container.getDatabase()}`;
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
    app.setGlobalPrefix('api/v1');
    await app.init();
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await container?.stop();
  });

  async function newPatient(): Promise<Patient> {
    const subject = `patient-${randomUUID()}`;
    const patientId = randomUUID();
    const profileId = randomUUID();
    await db.query(`INSERT INTO patients (id, oidc_subject, updated_at) VALUES ($1, $2, now())`, [
      patientId,
      subject,
    ]);
    await db.query(
      `INSERT INTO profiles (id, patient_id, ostomy_type, surgery_date, measurement_system, client_updated_at, updated_at)
       VALUES ($1, $2, 'ILEOSTOMY', (now() - interval '10 days')::date, 'METRIC', to_timestamp(0), now())`,
      [profileId, patientId],
    );
    return {
      patientId,
      profileId,
      token: await issuer.sign({ issuer: ISSUER, audience: AUDIENCE, subject }),
    };
  }

  function clientTime(seconds = 0): string {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }

  /** The id a device derives for this routine, with the RFC-checked core function (not the server's). */
  function idFor(patient: Patient, routine: QuickAddRoutine = ROUTINE): Promise<string> {
    return quickAddPreferenceId(patient.profileId, routine, sha1);
  }

  async function decisionOp(
    patient: Patient,
    options: {
      routine?: QuickAddRoutine;
      decision?: string;
      operationType?: 'create' | 'update' | 'delete';
      clientTimestamp?: string;
      entityId?: string;
      payload?: Record<string, unknown>;
    } = {},
  ): Promise<Record<string, unknown>> {
    const routine = options.routine ?? ROUTINE;
    const entityId = options.entityId ?? (await idFor(patient, routine));
    const operationType = options.operationType ?? 'create';
    return {
      operationId: randomUUID(),
      entityType: 'QuickAddPreference',
      entityId,
      operationType,
      clientTimestamp: options.clientTimestamp ?? clientTime(),
      ...(operationType === 'delete'
        ? {}
        : {
            payload: {
              id: entityId,
              ...routine,
              decision: options.decision ?? 'pinned',
              ...options.payload,
            },
          }),
    };
  }

  function push(patient: Patient, operations: unknown[]) {
    return request(app.getHttpServer())
      .post('/api/v1/sync/push')
      .set('Authorization', `Bearer ${patient.token}`)
      .send({ operations });
  }

  async function resultOf(patient: Patient, operation: Record<string, unknown>) {
    const response = await push(patient, [operation]).expect(200);
    return response.body.results[0] as {
      status: string;
      reasonCode?: string;
      field?: string;
    };
  }

  async function storedDecisions(patient: Patient): Promise<string[]> {
    const result = await db.query(
      `SELECT decision FROM quick_add_preferences WHERE patient_id = $1`,
      [patient.patientId],
    );
    return result.rows.map((row: { decision: string }) => row.decision);
  }

  async function pull(patient: Patient) {
    const response = await request(app.getHttpServer())
      .get('/api/v1/sync/delta')
      .set('Authorization', `Bearer ${patient.token}`)
      .query({ since: '0' })
      .expect(200);
    return (response.body.changes as Array<{ entityType: string; payload?: unknown }>).filter(
      (change) => change.entityType === 'QuickAddPreference',
    );
  }

  describe('every field survives the round trip (written first)', () => {
    /**
     * One write path, but the delta emitter names its fields one by one, so
     * the column list is read from the database: a new column fails here until
     * the payload, the push and the delta all carry it.
     */
    it('knows every content column quick_add_preferences has', async () => {
      const columns = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'quick_add_preferences'
          ORDER BY column_name`,
      );
      const bookkeeping = [
        'id',
        'patient_id',
        'client_updated_at',
        'server_sequence',
        'deleted_at',
        'created_at',
        'updated_at',
      ];
      expect(
        columns.rows
          .map((row: { column_name: string }) => row.column_name)
          .filter((name: string) => !bookkeeping.includes(name)),
      ).toEqual([
        'code',
        'decision',
        'entered_measurement_system',
        'fluid_type_code',
        'method',
        'urine_color_code',
        'value_ml',
      ]);
    });

    it.each([
      ['a measured output routine', ROUTINE],
      [
        'an estimated intake with a fluid type, in ounces, at the column scale',
        {
          code: '9000-1',
          valueMl: 354.8824,
          method: ESTIMATED,
          fluidTypeCode: 'water',
          urineColorCode: null,
          enteredMeasurementSystem: 'imperial' as const,
        },
      ],
      [
        'a colour-only urine routine',
        {
          code: '9187-6',
          valueMl: null,
          method: null,
          fluidTypeCode: null,
          urineColorCode: 'pale_yellow',
          enteredMeasurementSystem: 'metric' as const,
        },
      ],
    ])('pulls back exactly what was pushed: %s', async (_name, routine) => {
      const patient = await newPatient();
      const op = await decisionOp(patient, { routine, decision: 'hidden' });

      expect((await resultOf(patient, op)).status).toBe('accepted');

      const [change] = await pull(patient);
      expect(change?.payload).toEqual(op.payload);
    });
  });

  describe('one row per widget, whichever device decides', () => {
    /** The point of the derived id: two devices' decisions about one widget meet on one row. */
    it('applies a second device’s create to the same row, last write winning', async () => {
      const patient = await newPatient();
      await resultOf(
        patient,
        await decisionOp(patient, { decision: 'pinned', clientTimestamp: clientTime(-60) }),
      );

      const second = await resultOf(
        patient,
        await decisionOp(patient, { decision: 'hidden', clientTimestamp: clientTime(0) }),
      );

      expect(second.status).toBe('accepted');
      expect(await storedDecisions(patient)).toEqual(['HIDDEN']);
    });

    it('keeps the newer decision when an older one arrives late, and audits the loser', async () => {
      const patient = await newPatient();
      const id = await idFor(patient);
      await resultOf(
        patient,
        await decisionOp(patient, { decision: 'hidden', clientTimestamp: clientTime(0) }),
      );

      const late = await resultOf(
        patient,
        await decisionOp(patient, { decision: 'pinned', clientTimestamp: clientTime(-60) }),
      );

      expect(late.status).toBe('superseded');
      expect(await storedDecisions(patient)).toEqual(['HIDDEN']);
      const loser = await db.query(
        `SELECT before_value FROM audit_events
          WHERE entity_id = $1 AND reason_code = 'sync_conflict_loser'`,
        [id],
      );
      expect(
        loser.rows.map((row: { before_value: { decision: string } }) => row.before_value.decision),
      ).toContain('pinned');
    });

    it('undoes a decision with none, which every device then sees', async () => {
      const patient = await newPatient();
      await resultOf(
        patient,
        await decisionOp(patient, { decision: 'hidden', clientTimestamp: clientTime(-60) }),
      );

      const undo = await resultOf(
        patient,
        await decisionOp(patient, { decision: 'none', operationType: 'update' }),
      );

      expect(undo.status).toBe('accepted');
      const [change] = await pull(patient);
      expect(change?.payload).toMatchObject({ decision: 'none' });
    });

    /**
     * Two devices creating the same widget's row at once. Read without the
     * lock, the second sees no row (the first has not committed), inserts, and
     * fails on the primary key: a 500, which §9 tells a device to re-push
     * forever. Under the lock it waits, then sees the row and compares.
     */
    it('waits for a concurrent write to the same row, then compares against it', async () => {
      const patient = await newPatient();
      const id = await idFor(patient);
      const writer = new PgClient({ connectionString: runtimeDatabaseUrl });
      await writer.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          quickAddLockKey(id),
        ]);
        await writer.query(
          `INSERT INTO quick_add_preferences
             (id, patient_id, code, value_ml, method, entered_measurement_system, decision, client_updated_at, updated_at)
           VALUES ($1, $2, '79560-9', 350, $3, 'METRIC', 'HIDDEN', $4, now())`,
          [id, patient.patientId, MEASURED, clientTime(-10)],
        );

        // `.then` sends it: a supertest request is lazy until awaited.
        const pending = push(patient, [
          await decisionOp(patient, { decision: 'pinned', clientTimestamp: clientTime(-60) }),
        ]).then((response) => response);
        // Until the push is WAITING on the lock — not a fixed sleep, which
        // could let this pass without the lock ever being contended.
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const waiting = await db.query(
            `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
          );
          if (waiting.rows[0].n > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const blocked = await db.query(
          `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`,
        );
        expect(blocked.rows[0].n).toBe(1);
        await writer.query('COMMIT');

        const response = await pending;
        expect(response.status).toBe(200);
        expect(response.body.results[0].status).toBe('superseded');
        expect(await storedDecisions(patient)).toEqual(['HIDDEN']);
      } finally {
        await writer.query('ROLLBACK').catch(() => undefined);
        await writer.end();
      }
    });

    it('keeps two different widgets on two rows', async () => {
      const patient = await newPatient();
      await resultOf(patient, await decisionOp(patient));
      await resultOf(
        patient,
        await decisionOp(patient, { routine: { ...ROUTINE, method: ESTIMATED } }),
      );

      expect(await storedDecisions(patient)).toHaveLength(2);
    });
  });

  describe('the id must be the routine’s', () => {
    it('refuses a random id', async () => {
      const patient = await newPatient();

      expect(
        await resultOf(patient, await decisionOp(patient, { entityId: randomUUID() })),
      ).toMatchObject({
        status: 'rejected',
        reasonCode: 'PAYLOAD_FIELD_INVALID',
        field: 'id',
      });
    });

    it('refuses an id derived from another patient’s profile', async () => {
      const patient = await newPatient();
      const other = await newPatient();

      expect(
        await resultOf(patient, await decisionOp(patient, { entityId: await idFor(other) })),
      ).toMatchObject({ status: 'rejected', field: 'id' });
    });

    /** The id names the routine, so a payload describing a different one under it is refused. */
    it('refuses a routine that does not match its id', async () => {
      const patient = await newPatient();

      expect(
        await resultOf(patient, await decisionOp(patient, { payload: { valueMl: 355 } })),
      ).toMatchObject({ status: 'rejected', field: 'id' });
    });
  });

  describe('what a push cannot do', () => {
    it('never deletes a decision', async () => {
      const patient = await newPatient();

      expect(
        await resultOf(patient, await decisionOp(patient, { operationType: 'delete' })),
      ).toMatchObject({
        status: 'rejected',
        reasonCode: 'UNSUPPORTED_CODE',
        field: 'operationType',
      });
    });

    it('answers an update for a row nobody created as not found', async () => {
      const patient = await newPatient();

      expect(
        await resultOf(patient, await decisionOp(patient, { operationType: 'update' })),
      ).toMatchObject({ status: 'rejected', reasonCode: 'ENTITY_NOT_FOUND' });
    });

    it.each([
      ['an unknown code', { code: '29463-7' }, 'code'],
      ['a zero volume', { valueMl: 0 }, 'valueMl'],
      ['more decimals than the column holds', { valueMl: 350.12345 }, 'valueMl'],
      [
        'no volume on a routine that is not colour-only urine',
        { valueMl: null, method: null },
        'valueMl',
      ],
      ['a volume with no Measured/Estimated', { method: null }, 'method'],
      ['a method code that is neither', { method: '123' }, 'method'],
      ['a colour on output', { urineColorCode: 'pale_yellow' }, 'urineColorCode'],
      ['a fluid type on output', { fluidTypeCode: 'water' }, 'fluidTypeCode'],
      [
        'an unknown measurement system',
        { enteredMeasurementSystem: 'cubits' },
        'enteredMeasurementSystem',
      ],
      ['an unknown decision', { decision: 'starred' }, 'decision'],
      ['an absent field', { decision: undefined }, 'decision'],
    ])('refuses %s, naming the field', async (_name, change, field) => {
      const patient = await newPatient();
      const op = await decisionOp(patient);
      const payload: Record<string, unknown> = {
        ...(op.payload as Record<string, unknown>),
        ...(change as Record<string, unknown>),
      };
      for (const [key, value] of Object.entries(payload)) {
        if (value === undefined) delete payload[key];
      }

      expect(await resultOf(patient, { ...op, payload })).toMatchObject({
        status: 'rejected',
        reasonCode: 'PAYLOAD_FIELD_INVALID',
        field,
      });
      expect(await storedDecisions(patient)).toEqual([]);
    });

    it('refuses a field §7.7 does not define', async () => {
      const patient = await newPatient();
      const op = await decisionOp(patient);

      expect(
        await resultOf(patient, { ...op, payload: { ...(op.payload as object), template: 'x' } }),
      ).toMatchObject({ status: 'rejected', reasonCode: 'PAYLOAD_FIELD_UNRECOGNIZED' });
    });
  });

  describe('audit and bookkeeping', () => {
    it('audits a create with what was written, and an update with before and after', async () => {
      const patient = await newPatient();
      const id = await idFor(patient);
      await resultOf(
        patient,
        await decisionOp(patient, { decision: 'pinned', clientTimestamp: clientTime(-60) }),
      );
      await resultOf(
        patient,
        await decisionOp(patient, { decision: 'hidden', operationType: 'update' }),
      );

      const rows = await db.query(
        `SELECT action, before_value, after_value FROM audit_events
          WHERE entity_type = $1 AND entity_id = $2 AND reason_code <> 'sync_conflict_loser'
          ORDER BY occurred_at, action`,
        [QUICK_ADD_ENTITY_TYPE, id],
      );
      expect(rows.rows.map((row: { action: string }) => row.action)).toEqual(['CREATE', 'UPDATE']);
      expect(rows.rows[0].after_value).toMatchObject({ decision: 'pinned', valueMl: 350 });
      expect(rows.rows[1].before_value).toMatchObject({ decision: 'pinned' });
      expect(rows.rows[1].after_value).toMatchObject({ decision: 'hidden' });
    });

    it('records the idempotency row under its own entity type', async () => {
      const patient = await newPatient();
      const op = await decisionOp(patient);
      await resultOf(patient, op);

      const record = await db.query(
        `SELECT entity_type FROM sync_operations WHERE operation_id = $1`,
        [op.operationId],
      );
      expect(record.rows[0].entity_type).toBe('QUICK_ADD_PREFERENCE');
    });
  });
});
