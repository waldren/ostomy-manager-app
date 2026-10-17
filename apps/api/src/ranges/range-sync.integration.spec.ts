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
 * A patient's target ranges, written through sync (P4.S3 slice 3, #139,
 * `docs/sync-contract.md` §7.6, SRS §3.9 / AC 14.1).
 *
 * Against real PostgreSQL through the HTTP surface, because what matters here
 * is what a push leaves in `effective_ranges` and what `GET /api/v1/ranges`
 * then says is in force — the read P4.S2 built and slice 4 will render.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { Logger as NestLogger, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../app.module';
import { PATIENT_JWKS_RESOLVER } from '../auth/patient-jwks-resolver.token';
import type { AppConfig } from '../config/env.schema';
import { createTestOidcIssuer, type TestOidcIssuer } from '../test-support/oidc-test-tokens';

import { RANGE_ENTITY_TYPE } from './range-payload';

const API_ROOT = path.resolve(__dirname, '..', '..');
const ISSUER = 'https://issuer.test/patient';
const AUDIENCE = 'ostomy-patient-app';
const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'range-sync-integration-test-only-password';
const OUTPUT = 'daily_output_ml';

interface Patient {
  readonly patientId: string;
  readonly token: string;
}

describe('P4.S3 — target ranges through sync', () => {
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
      .withDatabase('ostomy_range_sync_test')
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

  /** A provisioned ileostomy patient, ten days after surgery. */
  async function newPatient(): Promise<Patient> {
    const subject = `patient-${randomUUID()}`;
    const patientId = randomUUID();
    await db.query(`INSERT INTO patients (id, oidc_subject, updated_at) VALUES ($1, $2, now())`, [
      patientId,
      subject,
    ]);
    await db.query(
      `INSERT INTO profiles (id, patient_id, ostomy_type, surgery_date, measurement_system, client_updated_at, updated_at)
       VALUES ($1, $2, 'ILEOSTOMY', (now() - interval '10 days')::date, 'METRIC', to_timestamp(0), now())`,
      [randomUUID(), patientId],
    );
    return { patientId, token: await issuer.sign({ issuer: ISSUER, audience: AUDIENCE, subject }) };
  }

  /** A device's clock reading, `seconds` from now, in §7.3's exact form. */
  function clientTime(seconds = 0): string {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }

  function rangeOp(
    options: {
      entityId?: string;
      operationType?: 'create' | 'update' | 'delete';
      clientTimestamp?: string;
      payload?: Record<string, unknown>;
    } = {},
  ): Record<string, unknown> {
    const entityId = options.entityId ?? randomUUID();
    const operationType = options.operationType ?? 'create';
    return {
      operationId: randomUUID(),
      entityType: 'EffectiveRange',
      entityId,
      operationType,
      clientTimestamp: options.clientTimestamp ?? clientTime(),
      ...(operationType === 'delete'
        ? {}
        : {
            payload: {
              id: entityId,
              rangeType: OUTPUT,
              lowValue: 500,
              highValue: 1200,
              targetValue: null,
              unit: 'mL',
              provenance: 'patient_set',
              status: 'active',
              previousRangeId: null,
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

  async function inForce(patient: Patient, rangeType = OUTPUT) {
    const response = await request(app.getHttpServer())
      .get('/api/v1/ranges')
      .set('Authorization', `Bearer ${patient.token}`)
      .expect(200);
    return (response.body.ranges as Array<Record<string, unknown>>).find(
      (range) => range.rangeType === rangeType,
    );
  }

  async function rows(patient: Patient): Promise<Array<Record<string, unknown>>> {
    const result = await db.query(
      `SELECT id, provenance, status, low_value::float AS low, high_value::float AS high, previous_range_id
         FROM effective_ranges WHERE patient_id = $1 ORDER BY client_updated_at, id`,
      [patient.patientId],
    );
    return result.rows;
  }

  async function insertRow(
    patient: Patient,
    fields: {
      provenance: string;
      status: string;
      low: number;
      high: number;
      clientUpdatedAt?: string;
    },
  ): Promise<string> {
    const id = randomUUID();
    await db.query(
      `INSERT INTO effective_ranges
         (id, patient_id, range_type, low_value, high_value, unit, provenance, status, client_updated_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'mL', $6, $7, $8, now())`,
      [
        id,
        patient.patientId,
        OUTPUT,
        fields.low,
        fields.high,
        fields.provenance,
        fields.status,
        fields.clientUpdatedAt ?? clientTime(-3600),
      ],
    );
    return id;
  }

  async function accepted(patient: Patient, operation: Record<string, unknown>) {
    const response = await push(patient, [operation]).expect(200);
    expect(response.body.results[0].status).toBe('accepted');
    return response.body.results[0];
  }

  describe('every field survives the round trip (written first)', () => {
    /**
     * This entity has one write path, so there is no second path to compare
     * against — but CLAUDE.md's field-drop lesson is about the READ side too:
     * the delta emitter names its fields one by one. So the column list is read
     * from the database, and a new column fails here until the payload, the
     * push and the delta all carry it.
     */
    it('knows every content column effective_ranges has', async () => {
      const columns = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'effective_ranges'
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
        'high_value',
        'low_value',
        'previous_range_id',
        'provenance',
        'range_type',
        'status',
        'target_value',
        'unit',
      ]);
    });

    it('pulls back exactly what was pushed', async () => {
      const patient = await newPatient();
      const op = rangeOp({ payload: { lowValue: 450.25, highValue: 1300.5 } });
      await accepted(patient, op);

      const pulled = await request(app.getHttpServer())
        .get('/api/v1/sync/delta')
        .set('Authorization', `Bearer ${patient.token}`)
        .query({ since: '0' })
        .expect(200);

      const change = pulled.body.changes.find(
        (entry: { entityType: string }) => entry.entityType === 'EffectiveRange',
      );
      expect(change.payload).toEqual(op.payload);
    });
  });

  describe('a patient’s own value (AC 14.1 AC2/AC3)', () => {
    it('confirming the suggestion makes it a threshold, recorded as confirmed', async () => {
      // Before: the default is a suggestion and NOT a threshold (AC2).
      const patient = await newPatient();
      expect(await inForce(patient)).toMatchObject({
        provenance: 'CLINICAL_DEFAULT',
        isActiveThreshold: false,
      });

      await accepted(patient, rangeOp({ payload: { provenance: 'patient_confirmed_suggestion' } }));

      expect(await inForce(patient)).toMatchObject({
        provenance: 'PATIENT_CONFIRMED_SUGGESTION',
        isActiveThreshold: true,
        lowValue: 500,
        highValue: 1200,
      });
    });

    it('a new value replaces the old one, which is kept and linked', async () => {
      const patient = await newPatient();
      const first = rangeOp({ clientTimestamp: clientTime(-60) });
      const second = rangeOp({
        clientTimestamp: clientTime(-10),
        payload: { lowValue: 600, highValue: 1500 },
      });
      await accepted(patient, first);
      await accepted(patient, second);

      // Looked up by id, not by position: superseding stamps the old row with
      // the new decision's time, so the two tie on every ordering column.
      const stored = await rows(patient);
      expect(stored).toHaveLength(2);
      expect(stored.find((row) => row.id === first.entityId)).toMatchObject({
        status: 'SUPERSEDED',
      });
      expect(stored.find((row) => row.id === second.entityId)).toMatchObject({
        status: 'ACTIVE',
        previous_range_id: first.entityId,
      });
      expect(await inForce(patient)).toMatchObject({ lowValue: 600, highValue: 1500 });
    });

    it('confirming the suggestion after setting one’s own value puts the suggestion in force', async () => {
      // Precedence ranks patient_set above a confirmed suggestion. Without the
      // one-patient-value rule this patient would stay on their own value with
      // no way to tell why.
      const patient = await newPatient();
      await accepted(patient, rangeOp({ clientTimestamp: clientTime(-60) }));
      await accepted(
        patient,
        rangeOp({
          clientTimestamp: clientTime(-10),
          payload: { provenance: 'patient_confirmed_suggestion', lowValue: 700, highValue: 1100 },
        }),
      );

      expect(await inForce(patient)).toMatchObject({
        provenance: 'PATIENT_CONFIRMED_SUGGESTION',
        lowValue: 700,
      });
      const active = (await rows(patient)).filter((row) => row.status === 'ACTIVE');
      expect(active).toHaveLength(1);
    });

    it('an older value arriving after a newer one is kept as history, not put in force', async () => {
      // Last-write-wins across rows: a device offline since T5 must not revert
      // a decision another device made at T10.
      const patient = await newPatient();
      const newer = rangeOp({ clientTimestamp: clientTime(-10), payload: { lowValue: 800 } });
      const older = rangeOp({ clientTimestamp: clientTime(-60), payload: { lowValue: 300 } });
      await accepted(patient, newer);
      await accepted(patient, older);

      expect(await inForce(patient)).toMatchObject({ lowValue: 800 });
      expect(await rows(patient)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: older.entityId, status: 'SUPERSEDED' }),
          expect.objectContaining({ id: newer.entityId, status: 'ACTIVE' }),
        ]),
      );
    });

    it('withdrawing it falls back to the suggestion, which is again not a threshold', async () => {
      const patient = await newPatient();
      const mine = rangeOp({ clientTimestamp: clientTime(-60) });
      await accepted(patient, mine);

      await accepted(
        patient,
        rangeOp({
          entityId: mine.entityId as string,
          operationType: 'update',
          clientTimestamp: clientTime(-10),
          payload: { status: 'superseded' },
        }),
      );

      expect(await inForce(patient)).toMatchObject({
        provenance: 'CLINICAL_DEFAULT',
        isActiveThreshold: false,
      });
    });

    it('audits the new value, and the value it displaced', async () => {
      const patient = await newPatient();
      const first = rangeOp({ clientTimestamp: clientTime(-60) });
      const second = rangeOp({ clientTimestamp: clientTime(-10), payload: { lowValue: 650 } });
      await accepted(patient, first);
      await accepted(patient, second);

      const created = await db.query(
        `SELECT action, after_value FROM audit_events WHERE entity_type = $1 AND entity_id = $2`,
        [RANGE_ENTITY_TYPE, second.entityId],
      );
      expect(created.rows).toEqual([
        expect.objectContaining({
          action: 'CREATE',
          after_value: expect.objectContaining({ lowValue: 650, status: 'active' }),
        }),
      ]);
      const displaced = await db.query(
        `SELECT before_value, after_value FROM audit_events
          WHERE entity_type = $1 AND entity_id = $2 AND action = 'UPDATE'`,
        [RANGE_ENTITY_TYPE, first.entityId],
      );
      expect(displaced.rows).toEqual([
        expect.objectContaining({
          before_value: expect.objectContaining({ status: 'active' }),
          after_value: expect.objectContaining({ status: 'superseded' }),
        }),
      ]);
    });
  });

  describe('a physician’s value is never the patient’s to change (AC 14.1 AC4)', () => {
    it('stays in force beside the patient’s own value, which is flagged as diverging', async () => {
      const patient = await newPatient();
      const physician = await insertRow(patient, {
        provenance: 'PHYSICIAN_SET',
        status: 'ACTIVE',
        low: 400,
        high: 1000,
      });

      await accepted(patient, rangeOp({ payload: { lowValue: 900, highValue: 1800 } }));

      expect(await inForce(patient)).toMatchObject({
        provenance: 'PHYSICIAN_SET',
        lowValue: 400,
        divergesFromPhysician: true,
      });
      expect((await rows(patient)).find((row) => row.id === physician)).toMatchObject({
        status: 'ACTIVE',
      });
    });

    it('refuses an update to the physician’s row, and a create claiming to be one', async () => {
      const patient = await newPatient();
      const physician = await insertRow(patient, {
        provenance: 'PHYSICIAN_SET',
        status: 'ACTIVE',
        low: 400,
        high: 1000,
      });

      const response = await push(patient, [
        rangeOp({
          entityId: physician,
          operationType: 'update',
          payload: {
            provenance: 'physician_set',
            lowValue: 400,
            highValue: 1000,
            status: 'superseded',
          },
        }),
        rangeOp({ payload: { provenance: 'physician_set' } }),
      ]);

      for (const result of response.body.results) {
        expect(result).toMatchObject({
          status: 'rejected',
          reasonCode: 'PAYLOAD_FIELD_INVALID',
          field: 'provenance',
        });
      }
      expect(await inForce(patient)).toMatchObject({ provenance: 'PHYSICIAN_SET', lowValue: 400 });
    });
  });

  describe('a proposal waits for a human (AC 14.1 AC2/AC3)', () => {
    it('is never in force until accepted, and is in force once it is', async () => {
      const patient = await newPatient();
      const proposal = await insertRow(patient, {
        provenance: 'PATIENT_CONFIRMED_SUGGESTION',
        status: 'PROPOSED',
        low: 550,
        high: 1250,
      });
      expect(await inForce(patient)).toMatchObject({ provenance: 'CLINICAL_DEFAULT' });

      await accepted(
        patient,
        rangeOp({
          entityId: proposal,
          operationType: 'update',
          payload: {
            provenance: 'patient_confirmed_suggestion',
            lowValue: 550,
            highValue: 1250,
            status: 'active',
          },
        }),
      );

      expect(await inForce(patient)).toMatchObject({
        provenance: 'PATIENT_CONFIRMED_SUGGESTION',
        lowValue: 550,
        isActiveThreshold: true,
      });
    });

    it('can be dismissed, and then never comes back', async () => {
      const patient = await newPatient();
      const proposal = await insertRow(patient, {
        provenance: 'PATIENT_CONFIRMED_SUGGESTION',
        status: 'PROPOSED',
        low: 550,
        high: 1250,
      });
      const payload = {
        provenance: 'patient_confirmed_suggestion',
        lowValue: 550,
        highValue: 1250,
      };

      await accepted(
        patient,
        rangeOp({
          entityId: proposal,
          operationType: 'update',
          clientTimestamp: clientTime(-60),
          payload: { ...payload, status: 'dismissed' },
        }),
      );
      const revived = await push(patient, [
        rangeOp({
          entityId: proposal,
          operationType: 'update',
          clientTimestamp: clientTime(-10),
          payload: { ...payload, status: 'active' },
        }),
      ]);

      expect(revived.body.results[0]).toMatchObject({ status: 'rejected', field: 'status' });
      expect(await inForce(patient)).toMatchObject({ provenance: 'CLINICAL_DEFAULT' });
    });
  });

  describe('what a patient cannot write', () => {
    it.each([
      [
        'the heart-rate safety bound',
        { rangeType: 'heart_rate_red_flag_bpm', unit: 'bpm', lowValue: null, highValue: 150 },
        'rangeType',
      ],
      ['a range type that does not exist', { rangeType: 'daily_output_mL' }, 'rangeType'],
      ['the wrong unit for the type', { unit: 'oz' }, 'unit'],
      ['a bound outside the type’s limits', { lowValue: -5 }, 'lowValue'],
      ['an inverted range', { lowValue: 1500, highValue: 500 }, 'highValue'],
      ['a range with no bound at all', { lowValue: null, highValue: null }, 'lowValue'],
      ['more decimal places than the column holds', { lowValue: 500.12345 }, 'lowValue'],
      ['a proposal', { status: 'proposed' }, 'status'],
      ['a link to an earlier row', { previousRangeId: randomUUID() }, 'previousRangeId'],
    ])('refuses %s, naming the field and never the value', async (_label, payload, field) => {
      const patient = await newPatient();

      const response = await push(patient, [rangeOp({ payload })]);

      expect(response.body.results[0]).toMatchObject({
        status: 'rejected',
        reasonCode: 'PAYLOAD_FIELD_INVALID',
        field,
      });
      expect(await rows(patient)).toEqual([]);
    });

    it('refuses a delete: history is kept, and a withdrawn value is superseded', async () => {
      const patient = await newPatient();
      const mine = rangeOp({ clientTimestamp: clientTime(-60) });
      await accepted(patient, mine);

      const response = await push(patient, [
        rangeOp({ entityId: mine.entityId as string, operationType: 'delete' }),
      ]);

      expect(response.body.results[0]).toMatchObject({
        reasonCode: 'UNSUPPORTED_CODE',
        field: 'operationType',
      });
    });

    it('refuses changing a value in place; a new value is a new row', async () => {
      const patient = await newPatient();
      const mine = rangeOp({ clientTimestamp: clientTime(-60) });
      await accepted(patient, mine);

      const response = await push(patient, [
        rangeOp({
          entityId: mine.entityId as string,
          operationType: 'update',
          clientTimestamp: clientTime(-10),
          payload: { lowValue: 999 },
        }),
      ]);

      expect(response.body.results[0]).toMatchObject({ status: 'rejected', field: 'lowValue' });
      expect(await inForce(patient)).toMatchObject({ lowValue: 500 });
    });

    it('cannot touch another patient’s range, and the probe is logged', async () => {
      const victim = await newPatient();
      const attacker = await newPatient();
      const theirs = rangeOp();
      await accepted(victim, theirs);

      const lines: string[] = [];
      const spy = vi.spyOn(NestLogger.prototype, 'warn').mockImplementation((message: unknown) => {
        lines.push(String(message));
      });
      let update;
      let create;
      try {
        update = await push(attacker, [
          rangeOp({
            entityId: theirs.entityId as string,
            operationType: 'update',
            payload: { status: 'superseded' },
          }),
        ]);
        create = await push(attacker, [rangeOp({ entityId: theirs.entityId as string })]);
      } finally {
        spy.mockRestore();
      }

      expect(update.body.results[0]).toMatchObject({ reasonCode: 'ENTITY_NOT_FOUND' });
      expect(create.body.results[0]).toMatchObject({ reasonCode: 'ENTITY_ID_CONFLICT' });
      expect(lines.filter((line) => line.includes('sync.push.cross_patient_entity'))).toHaveLength(
        2,
      );
      expect(await rows(victim)).toEqual([
        expect.objectContaining({ id: theirs.entityId, status: 'ACTIVE' }),
      ]);
    });
  });

  it('serialises two devices deciding at once, so only one value is in force', async () => {
    // One device's decision is being written and has not committed; another
    // arrives. Read without the lock, the second sees nothing in force and
    // becomes active too — two patient values for one type. Under the lock it
    // waits, then sees the newer decision and is kept as history.
    const patient = await newPatient();
    const writer = new PgClient({ connectionString: runtimeDatabaseUrl });
    await writer.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `${patient.patientId}:${OUTPUT}`,
      ]);
      await writer.query(
        `INSERT INTO effective_ranges
           (id, patient_id, range_type, low_value, high_value, unit, provenance, status, client_updated_at, updated_at)
         VALUES ($1, $2, $3, 700, 1100, 'mL', 'PATIENT_CONFIRMED_SUGGESTION', 'ACTIVE', $4, now())`,
        [randomUUID(), patient.patientId, OUTPUT, clientTime(-10)],
      );

      const pending = push(patient, [rangeOp({ clientTimestamp: clientTime(-60) })]).then(
        (response) => response,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      await writer.query('COMMIT');
      await pending;

      const active = (await rows(patient)).filter((row) => row.status === 'ACTIVE');
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({ provenance: 'PATIENT_CONFIRMED_SUGGESTION' });
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await writer.end();
    }
  });
});
