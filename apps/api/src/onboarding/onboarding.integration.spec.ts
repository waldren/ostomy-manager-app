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
*/

/**
 * Provisioning against real PostgreSQL (P4.S1, SRS §3.0, Epic 7).
 *
 * Integration rather than unit, because everything worth asserting here is a
 * database guarantee: that the patient and the profile are created atomically,
 * that the audit row commits with them, and that a second call cannot overwrite
 * a profile. A mocked Prisma would let all three pass while none held.
 *
 * SRS §3.0 and Epic 7 give requirements and user stories but no numbered AC
 * block, so per docs/testing.md these cite the requirement they come from
 * rather than an invented AC id. The sprint's exit criteria are on #122.
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

import { PROFILE_ENTITY_TYPE } from './onboarding.service';

const API_ROOT = path.resolve(__dirname, '..', '..');
const ISSUER = 'https://issuer.test/patient';
const AUDIENCE = 'ostomy-patient-app';
// The role the migration creates (ADR-0011's constrained runtime role), with a
// password this suite sets below — the migration creates it without a usable
// login, deliberately, so a deployment must supply one.
const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'onboarding-integration-test-only-password';

describe('P4.S1 — provisioning a patient and their profile', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication;
  let db: PgClient;
  let issuer: TestOidcIssuer;

  function testConfig(): AppConfig {
    return {
      nodeEnv: 'test',
      port: 0,
      logLevel: 'silent',
      oidcClockToleranceSeconds: 30,
      // No browser origin: these tests drive the API directly, not through one.
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

  let runtimeDatabaseUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('ostomy_onboarding_test')
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

    // The migration creates the runtime role without a usable login (ADR-0011:
    // role and grant changes go in a migration, never only in a Compose init
    // script, because Testcontainers starts its own PostgreSQL and never sees
    // one). A deployment supplies the password; so does this suite.
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
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await container?.stop();
  });

  /** A verified token for a subject the database has never heard of — the state this sprint exists to make usable. */
  async function newSubject(): Promise<{ subject: string; token: string }> {
    const subject = `patient-${randomUUID()}`;
    const token = await issuer.sign({ issuer: ISSUER, audience: AUDIENCE, subject });
    return { subject, token };
  }

  function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ostomyType: 'ileostomy',
      surgeryDate: '2026-01-15',
      measurementSystem: 'metric',
      ...overrides,
    };
  }

  function onboard(token: string, payload: unknown) {
    return request(app.getHttpServer())
      .post('/api/v1/onboarding')
      .set('Authorization', `Bearer ${token}`)
      .send(payload as object);
  }

  function readProfile(token: string) {
    return request(app.getHttpServer())
      .get('/api/v1/profile')
      .set('Authorization', `Bearer ${token}`);
  }

  describe('the three questions SRS §3.0 makes mandatory', () => {
    it('creates the patient and the profile from them, and nothing else is required', async () => {
      const { subject, token } = await newSubject();

      const response = await onboard(token, body());

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        id: expect.any(String),
        ostomyType: 'ileostomy',
        surgeryDate: '2026-01-15',
        measurementSystem: 'metric',
      });

      const rows = await db.query(
        `SELECT p.id AS patient_id, pr.ostomy_type, pr.surgery_date, pr.measurement_system
           FROM patients p JOIN profiles pr ON pr.patient_id = p.id
          WHERE p.oidc_subject = $1`,
        [subject],
      );
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0]).toMatchObject({
        ostomy_type: 'ILEOSTOMY',
        measurement_system: 'METRIC',
      });
    });

    it('keeps the surgery date a calendar date, not an instant', async () => {
      // `@db.Date`, and the wire carries `YYYY-MM-DD`. Storing an instant would
      // invent a time of day nobody recorded and make the Tier 1 bound depend on
      // the patient's timezone at onboarding rather than on the date they were
      // given.
      const { subject, token } = await newSubject();

      await onboard(token, body({ surgeryDate: '2026-02-29' })).expect(400);
      await onboard(token, body({ surgeryDate: '2026-03-01' })).expect(201);

      const rows = await db.query(
        `SELECT pr.surgery_date::text AS surgery_date
           FROM patients p JOIN profiles pr ON pr.patient_id = p.id
          WHERE p.oidc_subject = $1`,
        [subject],
      );
      expect(rows.rows[0].surgery_date).toBe('2026-03-01');
    });

    it('accepts imperial, which nothing in the app could select before this', async () => {
      // ADR-0004's imperial path has been implemented and unit-tested since P1.S4
      // and unreachable in the running app, because `DEFAULT_MEASUREMENT_SYSTEM`
      // is a constant. This endpoint is the first thing that can store the other
      // answer.
      const { token } = await newSubject();

      const response = await onboard(token, body({ measurementSystem: 'imperial' }));

      expect(response.status).toBe(201);
      expect(response.body.measurementSystem).toBe('imperial');
    });

    it('refuses a fourth field rather than ignoring it', async () => {
      // `strict()`. The shape of this request is the shape of the question the
      // patient is asked, so an extra field is a client that believes it is
      // asking something this endpoint does not record.
      const { token } = await newSubject();

      const response = await onboard(token, body({ baselineApplianceType: 'two-piece' }));

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('INVALID_ONBOARDING');
    });

    it('refuses urostomy, which v1 does not cover', async () => {
      // SRS Phase 4 Appendix A: a urostomy's stoma output IS urine, making it a
      // different data model rather than a third enum value.
      const { token } = await newSubject();

      await onboard(token, body({ ostomyType: 'urostomy' })).expect(400);
    });
  });

  describe('the surgery date is bounded, because it becomes a Tier 1 rule', () => {
    it('refuses a date in the future', async () => {
      // Otherwise the app accepts onboarding and then refuses the first entry the
      // patient tries to make, with a message about a date they chose on a screen
      // they have already left.
      //
      // Two days out rather than one, deliberately. The check tolerates
      // `MAX_TIMEZONE_HOURS_AHEAD_OF_UTC` (see the next test for why), so
      // "tomorrow" is inside the allowance for part of every UTC day — a test
      // asserting a refusal there would pass or fail depending on the hour the
      // suite happens to run at, which is worse than not asserting it.
      const { token } = await newSubject();
      const inTwoDays = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const response = await onboard(token, body({ surgeryDate: inTwoDays }));

      expect(response.status).toBe(400);
      expect(response.body.error.fields).toEqual([{ field: 'surgeryDate', rule: 'in_the_future' }]);
    });

    /**
     * The timezone allowance on that bound is NOT asserted here. It depends on the
     * hour of the UTC day, so a test against the ambient clock would exercise
     * whichever side of it the suite started on and pass either way — the kind of
     * green that means less than it looks. `surgery-date.spec.ts` states both
     * sides against a fixed instant instead.
     */
    it('refuses a date implausibly far in the past', async () => {
      // A slipped century passes every shape rule and silently disables the bound
      // for the life of the account, and nothing downstream reports a rule that
      // never fires.
      const { token } = await newSubject();

      const response = await onboard(token, body({ surgeryDate: '1025-03-04' }));

      expect(response.status).toBe(400);
      expect(response.body.error.fields).toEqual([
        { field: 'surgeryDate', rule: 'implausibly_old' },
      ]);
    });

    it('names the field and the rule, never the value', async () => {
      // CLAUDE.md: validation errors return field identifiers and rule codes,
      // "never the offending clinical value". A surgery date is clinical.
      const { token } = await newSubject();

      const response = await onboard(token, body({ surgeryDate: '1025-03-04' }));

      expect(JSON.stringify(response.body)).not.toContain('1025');
    });
  });

  describe('both rows or neither', () => {
    it('writes no patient when the profile is refused', async () => {
      // The transaction's whole point. A patient row with no profile would be a
      // state every later query has to defend against, and
      // `PATIENT_NOT_PROVISIONED` could not tell it apart from "never onboarded".
      const { subject, token } = await newSubject();

      await onboard(token, body({ surgeryDate: '1025-03-04' })).expect(400);

      const rows = await db.query(`SELECT 1 FROM patients WHERE oidc_subject = $1`, [subject]);
      expect(rows.rowCount).toBe(0);
    });

    it('commits the audit row with the write', async () => {
      // A profile carries an ostomy type and a surgery date, both
      // diagnosis-adjacent, so this is a PHI create and CLAUDE.md's audit rule
      // applies in full. The audit row is the only record that this patient came
      // into existence at all.
      const { subject, token } = await newSubject();

      await onboard(token, body()).expect(201);

      const audit = await db.query(
        `SELECT action, actor_type, actor_id, entity_type, after_value, before_value
           FROM audit_events WHERE entity_type = $1 AND actor_id = $2`,
        [PROFILE_ENTITY_TYPE, subject],
      );
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0]).toMatchObject({
        action: 'CREATE',
        actor_type: 'PATIENT',
        actor_id: subject,
      });
      expect(audit.rows[0].before_value).toBeNull();
      expect(audit.rows[0].after_value).toMatchObject({ ostomyType: 'ileostomy' });
    });
  });

  describe('a second call is a conflict, not an edit', () => {
    it('refuses it and leaves the stored profile untouched', async () => {
      // This endpoint means "I am new". Silently updating would make it a second,
      // unaudited edit path for a profile whose edits belong to P4.S3's sync
      // route — and would let a replayed request overwrite a surgery date the
      // patient has since corrected.
      const { subject, token } = await newSubject();
      await onboard(token, body()).expect(201);

      const second = await onboard(token, body({ surgeryDate: '2020-06-06' }));

      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('ALREADY_ONBOARDED');
      const rows = await db.query(
        `SELECT pr.surgery_date::text AS surgery_date
           FROM patients p JOIN profiles pr ON pr.patient_id = p.id
          WHERE p.oidc_subject = $1`,
        [subject],
      );
      expect(rows.rows[0].surgery_date).toBe('2026-01-15');
    });

    it('creates exactly one patient row for one subject', async () => {
      // `oidc_subject @unique` is the backstop; this is the interface. Two
      // `Patient` rows for one human is what that constraint exists to prevent.
      const { subject, token } = await newSubject();
      await onboard(token, body()).expect(201);
      await onboard(token, body()).expect(409);

      const rows = await db.query(
        `SELECT count(*)::int AS n FROM patients WHERE oidc_subject = $1`,
        [subject],
      );
      expect(rows.rows[0].n).toBe(1);
    });
  });

  describe('reading the profile is how a client decides to show onboarding', () => {
    it('answers it once the patient has onboarded', async () => {
      const { token } = await newSubject();
      await onboard(token, body({ measurementSystem: 'imperial' })).expect(201);

      const response = await readProfile(token);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        id: expect.any(String),
        ostomyType: 'ileostomy',
        surgeryDate: '2026-01-15',
        measurementSystem: 'imperial',
      });
    });

    it('answers PATIENT_NOT_PROVISIONED before they have', async () => {
      // The same code every write gives for the same state (#80), rather than a
      // second vocabulary the client would have to learn.
      const { token } = await newSubject();

      const response = await readProfile(token);

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PATIENT_NOT_PROVISIONED');
    });

    it('carries no patient identifier, and the profile’s own id', async () => {
      // The caller is the patient; the subject comes from the verified token. A
      // patient id in the body would be one on the wire that nothing needs — the
      // property `GET /api/v1/observations` already holds. The PROFILE's id is
      // there since P4.S3, as every observation's is: it is the `entityId` a
      // sync edit names (docs/sync-contract.md §7.5).
      const { subject, token } = await newSubject();
      await onboard(token, body()).expect(201);

      const response = await readProfile(token);

      expect(Object.keys(response.body).sort()).toEqual([
        'id',
        'measurementSystem',
        'ostomyType',
        'surgeryDate',
      ]);
      const row = await profileRow(subject);
      expect(response.body.id).toBe(row.id);
      expect(response.body.id).not.toBe(row.patient_id);
      expect(JSON.stringify(response.body)).not.toContain(subject);
      expect(JSON.stringify(response.body)).not.toContain(row.patient_id);
    });
  });

  describe('it is a patient route like any other', () => {
    it('refuses an unauthenticated request', async () => {
      await request(app.getHttpServer()).post('/api/v1/onboarding').send(body()).expect(401);
      await request(app.getHttpServer()).get('/api/v1/profile').expect(401);
    });

    it('resolves the subject from the token, never from the body', async () => {
      // A body-supplied subject would let any valid token provision a profile for
      // someone else. `strict()` refuses the field outright, which is the
      // stronger answer than ignoring it.
      const { subject, token } = await newSubject();
      const other = await newSubject();

      await onboard(token, body({ oidcSubject: other.subject })).expect(400);

      const rows = await db.query(`SELECT 1 FROM patients WHERE oidc_subject = $1`, [subject]);
      expect(rows.rowCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // P4.S3 — editing the profile, through sync
  // -------------------------------------------------------------------------

  /** The profile row for a subject, as stored. */
  async function profileRow(subject: string): Promise<Record<string, string>> {
    const rows = await db.query(
      `SELECT pr.id, pr.patient_id, pr.ostomy_type, pr.surgery_date::text AS surgery_date,
              pr.measurement_system, pr.client_updated_at
         FROM patients p JOIN profiles pr ON pr.patient_id = p.id
        WHERE p.oidc_subject = $1`,
      [subject],
    );
    return rows.rows[0];
  }

  function push(token: string, operations: unknown[]) {
    return request(app.getHttpServer())
      .post('/api/v1/sync/push')
      .set('Authorization', `Bearer ${token}`)
      .send({ operations });
  }

  function delta(token: string, since = '0') {
    return request(app.getHttpServer())
      .get('/api/v1/sync/delta')
      .set('Authorization', `Bearer ${token}`)
      .query({ since });
  }

  /** A device's clock reading, `seconds` from now — the lexical form §7.3 pins. */
  function clientTime(seconds = 0): string {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }

  function profileEdit(
    profileId: string,
    fields: Record<string, unknown>,
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      operationId: randomUUID(),
      entityType: 'Profile',
      entityId: profileId,
      operationType: 'update',
      clientTimestamp: clientTime(),
      payload: { id: profileId, ...body(), ...fields },
      ...overrides,
    };
  }

  /** Onboards a fresh subject and returns what a device would hold afterwards. */
  async function provisioned(overrides: Record<string, unknown> = {}) {
    const { subject, token } = await newSubject();
    const response = await onboard(token, body(overrides)).expect(201);
    return { subject, token, profileId: response.body.id as string };
  }

  describe('P4.S3 — both write paths persist the same profile fields', () => {
    /**
     * CLAUDE.md's "both write paths persist every field", for the entity that
     * now has two: provisioning creates a profile over REST, and every later
     * edit arrives over sync. Each names its columns explicitly, so a new
     * column added to one and forgotten in the other typechecks cleanly and
     * loses data for every patient who wrote it through the other path — the
     * `fluidTypeCode` defect, which survived two sprints.
     *
     * So this reads the column list from the DATABASE rather than from a list
     * in this file, and fails when a column appears that neither path was
     * taught about. Written before the sync payload existed, as P4.S1 committed
     * this sprint to.
     */
    const BOOKKEEPING_COLUMNS = [
      'id',
      'patient_id',
      'client_updated_at',
      'server_sequence',
      'deleted_at',
      'created_at',
      'updated_at',
    ];

    it('knows every content column the profiles table has', async () => {
      const columns = await db.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'profiles'
          ORDER BY column_name`,
      );
      const content = columns.rows
        .map((row: { column_name: string }) => row.column_name)
        .filter((name: string) => !BOOKKEEPING_COLUMNS.includes(name));

      // If this fails, a column was added to `profiles`. Teach BOTH
      // `OnboardingService.provision` and `SyncPushService.applyProfile` to
      // write it, then add it here and to the round trip below.
      expect(content).toEqual(['measurement_system', 'ostomy_type', 'surgery_date']);
    });

    it('stores the same row whichever path wrote the same answers', async () => {
      const answers = {
        ostomyType: 'colostomy',
        surgeryDate: '2025-11-30',
        measurementSystem: 'imperial',
      };

      // Path 1: provisioned with these answers directly.
      const viaRest = await provisioned(answers);

      // Path 2: provisioned with DIFFERENT answers, then edited to these.
      const viaSync = await provisioned();
      const edit = await push(viaSync.token, [profileEdit(viaSync.profileId, answers)]);
      expect(edit.status).toBe(200);
      expect(edit.body.results[0].status).toBe('accepted');

      const restRow = await profileRow(viaRest.subject);
      const syncRow = await profileRow(viaSync.subject);
      for (const column of ['ostomy_type', 'surgery_date', 'measurement_system']) {
        expect({ column, value: syncRow[column] }).toEqual({ column, value: restRow[column] });
      }
      expect(syncRow).toMatchObject({
        ostomy_type: 'COLOSTOMY',
        surgery_date: '2025-11-30',
        measurement_system: 'IMPERIAL',
      });
    });

    it('reads back the same profile through GET /profile and the delta pull', async () => {
      // The two READ paths name their fields separately too.
      const patient = await provisioned({ measurementSystem: 'imperial' });

      const rest = await readProfile(patient.token).expect(200);
      const pulled = await delta(patient.token).expect(200);

      const change = pulled.body.changes.find(
        (entry: { entityType: string }) => entry.entityType === 'Profile',
      );
      expect(change).toMatchObject({ entityId: patient.profileId, deleted: false });
      expect(change.payload).toEqual(rest.body);
    });
  });

  describe('P4.S3 — editing the profile over sync', () => {
    it('applies an edit, and audits it with before and after values', async () => {
      // SRS §3.10: "editable but audit-logged, since the surgery date is a
      // validation boundary".
      const patient = await provisioned();

      const response = await push(patient.token, [
        profileEdit(patient.profileId, { surgeryDate: '2026-01-10' }),
      ]);

      expect(response.body.results[0]).toMatchObject({
        status: 'accepted',
        entityId: patient.profileId,
      });
      expect((await profileRow(patient.subject)).surgery_date).toBe('2026-01-10');

      const audit = await db.query(
        `SELECT action, reason_code, before_value, after_value, actor_id
           FROM audit_events
          WHERE entity_type = $1 AND entity_id = $2 AND reason_code = 'sync_applied'`,
        [PROFILE_ENTITY_TYPE, patient.profileId],
      );
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0]).toMatchObject({ action: 'UPDATE', actor_id: patient.subject });
      expect(audit.rows[0].before_value).toMatchObject({ surgeryDate: '2026-01-15' });
      expect(audit.rows[0].after_value).toMatchObject({ surgeryDate: '2026-01-10' });

      // §4.1's second obligation: the displaced stored version, as its own row.
      // Nothing asserted it, so deleting that write would have passed.
      const displaced = await db.query(
        `SELECT before_value, after_value FROM audit_events
          WHERE entity_type = $1 AND entity_id = $2 AND reason_code = 'sync_conflict_loser'`,
        [PROFILE_ENTITY_TYPE, patient.profileId],
      );
      expect(displaced.rowCount).toBe(1);
      expect(displaced.rows[0].before_value).toMatchObject({ surgeryDate: '2026-01-15' });
      expect(displaced.rows[0].after_value).toBeNull();
    });

    it('answers a replayed edit with its first result, and writes nothing twice', async () => {
      // §3.7. A lost response makes the device re-push the same operation.
      const patient = await provisioned();
      const edit = profileEdit(patient.profileId, { measurementSystem: 'imperial' });

      const first = await push(patient.token, [edit]).expect(200);
      const second = await push(patient.token, [edit]).expect(200);

      expect(second.body.results[0]).toEqual({ ...first.body.results[0], replayed: true });
      const audit = await db.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1 AND reason_code LIKE 'sync_%'`,
        [patient.profileId],
      );
      expect(audit.rows[0].n).toBe(2);
    });

    it('records the idempotency row as a PROFILE operation', async () => {
      const patient = await provisioned();
      const edit = profileEdit(patient.profileId, { measurementSystem: 'imperial' });

      await push(patient.token, [edit]).expect(200);

      const rows = await db.query(
        `SELECT entity_type FROM sync_operations WHERE operation_id = $1`,
        [edit.operationId],
      );
      expect(rows.rows[0].entity_type).toBe('PROFILE');
    });

    it('wins against provisioning even from a phone whose clock runs slow', async () => {
      // Provisioning asserts no client time. It used to record the server's
      // now(), so a phone two minutes slow that changed a setting right after
      // onboarding sent a clientTimestamp EARLIER than the provisioning version:
      // superseded, moved to the audit log, and the phone silently reverted on
      // its next pull.
      const patient = await provisioned();

      const response = await push(patient.token, [
        profileEdit(
          patient.profileId,
          { measurementSystem: 'imperial' },
          { clientTimestamp: clientTime(-120) },
        ),
      ]);

      expect(response.body.results[0].status).toBe('accepted');
      expect((await profileRow(patient.subject)).measurement_system).toBe('IMPERIAL');
    });

    it('resolves two devices’ edits by last-write-wins, auditing the loser', async () => {
      const patient = await provisioned();
      const newer = profileEdit(
        patient.profileId,
        { ostomyType: 'colostomy' },
        { clientTimestamp: clientTime(-10) },
      );
      const older = profileEdit(
        patient.profileId,
        { measurementSystem: 'imperial' },
        { clientTimestamp: clientTime(-60) },
      );

      await push(patient.token, [newer]).expect(200);
      const response = await push(patient.token, [older]);

      expect(response.body.results[0].status).toBe('superseded');
      expect(await profileRow(patient.subject)).toMatchObject({
        ostomy_type: 'COLOSTOMY',
        measurement_system: 'METRIC',
      });
      // The INCOMING version that lost, preserved rather than discarded (§4.1).
      // Selected by content, not by recency: the first push's displaced-version
      // row and this one can share a millisecond, and ids are random.
      const loser = await db.query(
        `SELECT before_value FROM audit_events
          WHERE entity_id = $1 AND reason_code = 'sync_conflict_loser'
            AND before_value->>'measurementSystem' = 'imperial'`,
        [patient.profileId],
      );
      expect(loser.rowCount).toBe(1);
      expect(loser.rows[0].before_value).toMatchObject({ clientUpdatedAt: older.clientTimestamp });
    });

    it('rejects an invalid edit even when it is older, so its content never reaches the audit store', async () => {
      // Validated before the conflict comparison. Compared first, an older
      // payload carrying anything at all in a known field would be superseded
      // and its raw value copied into an append-only table.
      const patient = await provisioned();
      await push(patient.token, [
        profileEdit(
          patient.profileId,
          { ostomyType: 'colostomy' },
          { clientTimestamp: clientTime(-10) },
        ),
      ]).expect(200);

      const response = await push(patient.token, [
        profileEdit(
          patient.profileId,
          { ostomyType: 'free text the patient never typed' },
          { clientTimestamp: clientTime(-60) },
        ),
      ]);

      expect(response.body.results[0]).toMatchObject({
        status: 'rejected',
        reasonCode: 'PAYLOAD_FIELD_INVALID',
        field: 'ostomyType',
      });
      const audit = await db.query(
        `SELECT 1 FROM audit_events WHERE entity_id = $1 AND before_value::text LIKE '%free text%'`,
        [patient.profileId],
      );
      expect(audit.rowCount).toBe(0);
    });

    it('lets a concurrent edit finish before comparing, so the older one cannot win', async () => {
      // Two devices, one row. A newer version is being written and has not
      // committed; an older push arrives. Compared against a read taken outside
      // the transaction, the older push sees the provisioning version, passes,
      // waits on the row lock for the UPDATE, then overwrites the newer one —
      // and its audit row names the wrong version as displaced. Under the row
      // lock it waits BEFORE comparing, and loses.
      const patient = await provisioned();
      const writer = new PgClient({ connectionString: runtimeDatabaseUrl });
      await writer.connect();
      try {
        await writer.query('BEGIN');
        await writer.query(
          `UPDATE profiles SET ostomy_type = 'COLOSTOMY', client_updated_at = $2 WHERE id = $1`,
          [patient.profileId, clientTime(-10)],
        );

        const pending = push(patient.token, [
          profileEdit(
            patient.profileId,
            { measurementSystem: 'imperial' },
            { clientTimestamp: clientTime(-60) },
          ),
        ]).then((response) => response);
        // Long enough for the push to reach the lock and block on it.
        await new Promise((resolve) => setTimeout(resolve, 500));
        await writer.query('COMMIT');

        const response = await pending;
        expect(response.body.results[0].status).toBe('superseded');
        expect(await profileRow(patient.subject)).toMatchObject({
          ostomy_type: 'COLOSTOMY',
          measurement_system: 'METRIC',
        });
      } finally {
        await writer.query('ROLLBACK').catch(() => undefined);
        await writer.end();
      }
    });

    it('refuses a create or a delete, naming operationType', async () => {
      // A profile is created by provisioning and deleted by account deletion
      // (ADR-0017); neither is a sync write.
      const patient = await provisioned();
      const create = profileEdit(patient.profileId, {}, { operationType: 'create' });
      const remove = {
        ...profileEdit(patient.profileId, {}, { operationType: 'delete' }),
        payload: undefined,
      };

      const response = await push(patient.token, [create, remove]);

      for (const result of response.body.results) {
        expect(result).toMatchObject({
          status: 'rejected',
          reasonCode: 'UNSUPPORTED_CODE',
          field: 'operationType',
        });
      }
      const rows = await db.query(`SELECT deleted_at FROM profiles WHERE id = $1`, [
        patient.profileId,
      ]);
      expect(rows.rows[0].deleted_at).toBeNull();
    });

    it('cannot edit another patient’s profile', async () => {
      // §2: by (patient, id) together. Answered exactly as an id that exists
      // for nobody, so the response cannot confirm the other profile exists.
      const victim = await provisioned();
      const attacker = await provisioned();
      const auditBefore = await db.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1`,
        [victim.profileId],
      );

      const lines: string[] = [];
      const spy = vi.spyOn(NestLogger.prototype, 'warn').mockImplementation((message: unknown) => {
        lines.push(String(message));
      });
      let theirs;
      let nobodys;
      try {
        theirs = await push(attacker.token, [
          profileEdit(victim.profileId, { surgeryDate: '2020-01-01' }),
        ]);
        nobodys = await push(attacker.token, [
          profileEdit(randomUUID(), { surgeryDate: '2020-01-01' }),
        ]);
      } finally {
        spy.mockRestore();
      }

      // The operator sees the probe against a real profile, and only that one.
      const probes = lines.filter((line) => line.includes('sync.push.cross_patient_entity'));
      expect(probes).toHaveLength(1);
      expect(probes[0]).toContain(victim.profileId);
      const auditAfter = await db.query(
        `SELECT count(*)::int AS n FROM audit_events WHERE entity_id = $1`,
        [victim.profileId],
      );
      expect(auditAfter.rows[0].n).toBe(auditBefore.rows[0].n);

      expect(theirs.body.results[0]).toMatchObject({
        status: 'rejected',
        reasonCode: 'ENTITY_NOT_FOUND',
        field: 'entityId',
      });
      expect(nobodys.body.results[0]).toMatchObject({
        reasonCode: theirs.body.results[0].reasonCode,
        field: theirs.body.results[0].field,
      });
      expect((await profileRow(victim.subject)).surgery_date).toBe('2026-01-15');
    });

    it.each([
      ['an ostomy type v1 does not cover', { ostomyType: 'urostomy' }, 'ostomyType'],
      [
        'a measurement system that does not exist',
        { measurementSystem: 'cubits' },
        'measurementSystem',
      ],
      ['a surgery date that is not a date', { surgeryDate: '2026-02-30' }, 'surgeryDate'],
      ['a surgery date implausibly far in the past', { surgeryDate: '1025-03-04' }, 'surgeryDate'],
    ])('refuses %s, naming the field and never the value', async (_label, fields, field) => {
      const patient = await provisioned();

      const response = await push(patient.token, [profileEdit(patient.profileId, fields)]);

      expect(response.body.results[0]).toMatchObject({
        status: 'rejected',
        reasonCode: 'PAYLOAD_FIELD_INVALID',
        field,
      });
      expect(JSON.stringify(response.body)).not.toContain(String(Object.values(fields)[0]));
      expect(await profileRow(patient.subject)).toMatchObject({
        ostomy_type: 'ILEOSTOMY',
        surgery_date: '2026-01-15',
        measurement_system: 'METRIC',
      });
    });

    it('refuses a surgery date in the future, with onboarding’s allowance', async () => {
      // Two days out, for the reason the onboarding test above gives: "tomorrow"
      // is inside MAX_TIMEZONE_HOURS_AHEAD_OF_UTC for part of every UTC day.
      const patient = await provisioned();
      const inTwoDays = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const response = await push(patient.token, [
        profileEdit(patient.profileId, { surgeryDate: inTwoDays }),
      ]);

      expect(response.body.results[0]).toMatchObject({
        reasonCode: 'PAYLOAD_FIELD_INVALID',
        field: 'surgeryDate',
      });
    });

    it('refuses a field the profile does not have', async () => {
      const patient = await provisioned();

      const response = await push(patient.token, [
        profileEdit(patient.profileId, { targetDryWeightKg: 70 }),
      ]);

      expect(response.body.results[0]).toMatchObject({
        reasonCode: 'PAYLOAD_FIELD_UNRECOGNIZED',
        field: 'payload',
      });
      // Never the key: it is client-supplied content (§6.2).
      expect(JSON.stringify(response.body)).not.toContain('targetDryWeightKg');
    });

    it('refuses a clock set too far ahead, which would win every later conflict', async () => {
      const patient = await provisioned();

      const response = await push(patient.token, [
        profileEdit(
          patient.profileId,
          { ostomyType: 'colostomy' },
          { clientTimestamp: clientTime(3600) },
        ),
      ]);

      expect(response.body.results[0]).toMatchObject({
        reasonCode: 'CLIENT_TIMESTAMP_OUT_OF_RANGE',
        field: 'clientTimestamp',
      });
    });
  });

  describe('P4.S3 — a moved surgery date is the bound for what follows it', () => {
    function entryBefore(
      clientSeconds: number,
      effectiveDateTime: string,
    ): Record<string, unknown> {
      const id = randomUUID();
      return {
        operationId: randomUUID(),
        entityType: 'Observation',
        entityId: id,
        operationType: 'create',
        clientTimestamp: clientTime(clientSeconds),
        payload: {
          resourceType: 'Observation',
          id,
          status: 'final',
          code: '79560-9',
          valueQuantity: { value: 300, unit: 'mL' },
          effectiveDateTime,
          method: null,
          enteredMeasurementSystem: 'metric',
          enteredTimezone: 'UTC',
        },
      };
    }

    it('validates an entry queued after the edit against the NEW date', async () => {
      // The device moved the surgery date earlier and then backdated an entry
      // into the newly valid days. It validated that entry against the new date;
      // the server must too, or it refuses an entry the patient made correctly.
      const patient = await provisioned(); // surgery 2026-01-15

      const response = await push(patient.token, [
        profileEdit(
          patient.profileId,
          { surgeryDate: '2026-01-05' },
          { clientTimestamp: clientTime(-20) },
        ),
        entryBefore(-10, '2026-01-10T12:00:00.000Z'),
      ]);

      expect(response.body.results.map((r: { status: string }) => r.status)).toEqual([
        'accepted',
        'accepted',
      ]);
    });

    it('validates an entry queued BEFORE the edit against the old date', async () => {
      const patient = await provisioned();

      const response = await push(patient.token, [
        entryBefore(-20, '2026-01-10T12:00:00.000Z'),
        profileEdit(
          patient.profileId,
          { surgeryDate: '2026-01-05' },
          { clientTimestamp: clientTime(-10) },
        ),
      ]);

      expect(response.body.results[0]).toMatchObject({
        status: 'rejected',
        reasonCode: 'EFFECTIVE_DATE_TIME_BEFORE_SURGERY',
      });
      expect(response.body.results[1].status).toBe('accepted');
    });

    it('does not move the bound when the edit loses', async () => {
      // Only an ACCEPTED edit changes the stored date, so only an accepted one
      // may change what the rest of the batch is checked against. Carrying any
      // non-rejected result would let a superseded edit relax the bound.
      const patient = await provisioned();
      await push(patient.token, [
        profileEdit(
          patient.profileId,
          { ostomyType: 'colostomy' },
          { clientTimestamp: clientTime(-10) },
        ),
      ]).expect(200);

      const response = await push(patient.token, [
        profileEdit(
          patient.profileId,
          { surgeryDate: '2026-01-05' },
          { clientTimestamp: clientTime(-60) },
        ),
        entryBefore(-5, '2026-01-10T12:00:00.000Z'),
      ]);

      expect(response.body.results[0].status).toBe('superseded');
      expect(response.body.results[1]).toMatchObject({
        status: 'rejected',
        reasonCode: 'EFFECTIVE_DATE_TIME_BEFORE_SURGERY',
      });
    });

    it('does not re-validate entries already accepted', async () => {
      // Moving the date LATER makes an accepted entry look "before surgery".
      // Tier 1 applies on write; history is not re-checked against a mutable
      // profile (the shape ADR-0016 refuses for local_date).
      const patient = await provisioned();
      const entry = entryBefore(-20, '2026-01-20T12:00:00.000Z');
      await push(patient.token, [entry]).expect(200);

      await push(patient.token, [
        profileEdit(
          patient.profileId,
          { surgeryDate: '2026-02-01' },
          { clientTimestamp: clientTime(-10) },
        ),
      ]).expect(200);

      const rows = await db.query(`SELECT deleted_at FROM observations WHERE id = $1`, [
        entry.entityId,
      ]);
      expect(rows.rowCount).toBe(1);
      expect(rows.rows[0].deleted_at).toBeNull();
    });
  });

  describe('P4.S3 — an edit on one device reaches the others', () => {
    it('appears in the delta pull with the edited values', async () => {
      // SRS §3.10: "Preferences synchronize across devices via the Section 4.5
      // pull-sync delta endpoint". A second device is a second pull with the
      // same account's token.
      const patient = await provisioned();
      const before = await delta(patient.token).expect(200);

      await push(patient.token, [
        profileEdit(patient.profileId, { measurementSystem: 'imperial' }),
      ]).expect(200);
      const after = await delta(patient.token, before.body.cursor).expect(200);

      expect(after.body.changes).toHaveLength(1);
      expect(after.body.changes[0]).toMatchObject({
        entityType: 'Profile',
        entityId: patient.profileId,
        payload: { id: patient.profileId, measurementSystem: 'imperial' },
      });
    });

    it('never shows one patient another’s profile', async () => {
      const mine = await provisioned();
      const theirs = await provisioned();

      const pulled = await delta(mine.token).expect(200);

      const ids = pulled.body.changes.map((change: { entityId: string }) => change.entityId);
      expect(ids).toContain(mine.profileId);
      expect(ids).not.toContain(theirs.profileId);
    });
  });
});
