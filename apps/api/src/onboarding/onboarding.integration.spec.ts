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

import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
      const { token } = await newSubject();
      const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const response = await onboard(token, body({ surgeryDate: tomorrow }));

      expect(response.status).toBe(400);
      expect(response.body.error.fields).toEqual([{ field: 'surgeryDate', rule: 'in_the_future' }]);
    });

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

    it('carries no patient identifier', async () => {
      // The caller is the patient; the subject comes from the verified token. An
      // id in the body would be a patient identifier on the wire that nothing
      // needs — the property `GET /api/v1/observations` already holds.
      const { subject, token } = await newSubject();
      await onboard(token, body()).expect(201);

      const response = await readProfile(token);

      expect(Object.keys(response.body).sort()).toEqual([
        'measurementSystem',
        'ostomyType',
        'surgeryDate',
      ]);
      expect(JSON.stringify(response.body)).not.toContain(subject);
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
});
