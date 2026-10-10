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
 * `GET /api/v1/ranges` over HTTP (P4.S2 slice 3, #130).
 *
 * `ranges.integration.spec.ts` drives `RangesService` directly and owns the
 * precedence and index rules. This covers only what the HTTP layer adds: the
 * guard, the wire shape, and that a read writes no audit row. Duplicating the
 * precedence cases here would double the runtime to re-prove something one
 * layer down.
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

const API_ROOT = path.resolve(__dirname, '..', '..');
const ISSUER = 'https://issuer.test/patient';
const AUDIENCE = 'ostomy-patient-app';
const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'ranges-http-integration-test-only-password';

interface WireRange {
  rangeType: string;
  unit: string;
  lowValue: number | null;
  highValue: number | null;
  provenance: string;
  isActiveThreshold: boolean;
  divergesFromPhysician: boolean;
  basis: {
    ostomyType: string;
    daysPostOp: number;
    minDaysPostOp: number;
    maxDaysPostOp: number | null;
  } | null;
}

describe('GET /api/v1/ranges', () => {
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
      .withDatabase('ostomy_ranges_http_test')
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

  /** A provisioned patient, `daysPostOp` days after their surgery. */
  async function newPatient(daysPostOp: number): Promise<string> {
    const subject = `patient-${randomUUID()}`;
    const patientId = randomUUID();
    await db.query(`INSERT INTO patients (id, oidc_subject, updated_at) VALUES ($1, $2, now())`, [
      patientId,
      subject,
    ]);
    await db.query(
      `INSERT INTO profiles (id, patient_id, ostomy_type, surgery_date, measurement_system, client_updated_at, updated_at)
       VALUES ($1, $2, 'ILEOSTOMY', (now() - make_interval(days => $3))::date, 'METRIC', now(), now())`,
      [randomUUID(), patientId, daysPostOp],
    );
    return issuer.sign({ issuer: ISSUER, audience: AUDIENCE, subject });
  }

  const get = (token: string) =>
    request(app.getHttpServer()).get('/api/v1/ranges').set('Authorization', `Bearer ${token}`);

  it('refuses an unauthenticated read', async () => {
    await request(app.getHttpServer()).get('/api/v1/ranges').expect(401);
  });

  /**
   * AC 1's data: the value and the window it came from, so a client can state
   * the basis in its own words. The copy itself is the catalog's job (ADR-0006)
   * — an English sentence assembled server-side would be untranslatable and
   * invisible to the review §3.9's framing constraint exists for.
   */
  it('returns the suggested range with the basis a client needs to explain it', async () => {
    const token = await newPatient(10);

    const response = await get(token).expect(200);
    const ranges = response.body.ranges as WireRange[];
    const output = ranges.find((range) => range.rangeType === 'daily_output_ml');

    expect(output).toMatchObject({
      unit: 'mL',
      lowValue: 600,
      highValue: 1500,
      provenance: 'CLINICAL_DEFAULT',
      isActiveThreshold: false,
      divergesFromPhysician: false,
    });
    expect(output?.basis).toEqual({
      ostomyType: 'ileostomy',
      daysPostOp: 10,
      minDaysPostOp: 0,
      maxDaysPostOp: 30,
    });
  });

  /**
   * AC 2 on the wire. A client reading this must not flag an anomaly against a
   * range nobody confirmed, and `isActiveThreshold` is the field that says so —
   * so it has to survive serialisation, not merely exist in the service.
   */
  it('marks every unconfirmed default as not a threshold', async () => {
    const token = await newPatient(10);

    const ranges = (await get(token).expect(200)).body.ranges as WireRange[];

    expect(ranges).not.toHaveLength(0);
    expect(ranges.every((range) => range.isActiveThreshold === false)).toBe(true);
  });

  it('never exposes the heart-rate safety bound as a patient range', async () => {
    const token = await newPatient(10);

    const ranges = (await get(token).expect(200)).body.ranges as WireRange[];

    expect(ranges.map((range) => range.rangeType).sort()).toEqual([
      'daily_output_ml',
      'net_fluid_balance_ml',
      'urine_output_adequacy_ml',
    ]);
  });

  /** A floor with no ceiling must serialise as `null`, not as `0` — a zero here would be a bound nobody set. */
  it('sends a missing bound as null rather than zero', async () => {
    const token = await newPatient(10);

    const ranges = (await get(token).expect(200)).body.ranges as WireRange[];
    const urine = ranges.find((range) => range.rangeType === 'urine_output_adequacy_ml');

    expect(urine?.lowValue).toBe(1000);
    expect(urine?.highValue).toBeNull();
  });

  /**
   * An unprovisioned subject gets an empty list rather than a 403.
   *
   * Deliberately unlike `GET /api/v1/profile`, which answers
   * `PATIENT_NOT_PROVISIONED` because the client routes on it to decide whether
   * to show onboarding. Nothing routes on this: "you have no ranges yet" and
   * "you have no profile yet" lead to the same screen, and a second code for it
   * would be a second thing for a client to handle.
   */
  it('answers an empty list for a subject with no profile', async () => {
    const subject = `patient-${randomUUID()}`;
    await db.query(`INSERT INTO patients (id, oidc_subject, updated_at) VALUES ($1, $2, now())`, [
      randomUUID(),
      subject,
    ]);
    const token = await issuer.sign({ issuer: ISSUER, audience: AUDIENCE, subject });

    const response = await get(token).expect(200);

    expect(response.body).toEqual({ ranges: [] });
  });

  /**
   * SRS §5.2: a read is not an audit event. Asserted rather than assumed,
   * because the global `AuditInterceptor` is capable of auditing every route and
   * `route-guard-coverage.spec.ts` only requires the decorator on mutating ones
   * — nothing structurally stops a read acquiring one.
   */
  it('writes no audit row', async () => {
    const token = await newPatient(10);
    const before = await db.query(`SELECT count(*)::int AS n FROM audit_events`);

    await get(token).expect(200);

    const after = await db.query(`SELECT count(*)::int AS n FROM audit_events`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  /**
   * The response carries no patient identifier in either direction — the same
   * property `GET /api/v1/observations` holds, and for the same reason: the
   * caller is the patient, so an id on the wire is one nothing needs.
   */
  it('carries no patient identifier', async () => {
    const token = await newPatient(10);

    const response = await get(token).expect(200);

    expect(JSON.stringify(response.body)).not.toContain('patientId');
    expect(JSON.stringify(response.body)).not.toContain('patient_id');
  });
});
