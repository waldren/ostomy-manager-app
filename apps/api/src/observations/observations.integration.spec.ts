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
 * P2.S1a's proof, against real PostgreSQL (Testcontainers, ADR-0002),
 * connected as the **runtime** role and never the owner (ADR-0011: a test
 * connecting as the owner would pass regardless).
 *
 * The whole `AppModule` graph is booted, not a hand-assembled subset: the
 * global `AuditInterceptor`, the request-id middleware that supplies the
 * correlation id, and the real guard are all things this sprint depends on,
 * and a test harness that omits any of them proves the wrong thing.
 *
 * What each block covers is named against the acceptance criterion it comes
 * from, because "the tests pass" and "the criterion is met" are different
 * claims.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { inspect } from 'node:util';

import { Module, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { createApiClient, ApiError } from '@ostomy/core/api-client';
import { Logger as PinoNestLogger, LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AppModule } from '../app.module';
import { PATIENT_JWKS_RESOLVER } from '../auth/patient-jwks-resolver.token';
import type { AppConfig } from '../config/env.schema';
import { LoggingModule } from '../logging/logging.module';
import { CREDENTIAL_REDACTION_PATHS, PHI_SHAPED_REDACTION_PATHS } from '../logging/redaction';
import { errSerializer, reqSerializer, resSerializer } from '../logging/serializers';
import { createTestOidcIssuer, type TestOidcIssuer } from '../test-support/oidc-test-tokens';
import { OBSERVATION_ENTITY_TYPE } from './observations.service';
import { THRESHOLD_KEY } from '../thresholds/thresholds.service';

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
      '[observations.integration.spec.ts] Docker is not reachable, but CI is set — refusing to ' +
        "silently skip P2.S1a's PHI-write proof.",
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    '[observations.integration.spec.ts] Docker is not reachable — skipping. Run with a Docker ' +
      'daemon available (e.g. `pnpm --filter @ostomy/api test:integration`).',
  );
}

const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'observations-integration-test-only-password';
const ISSUER = 'https://mock-oidc.test/patient-issuer';
const AUDIENCE = 'ostomy-patient-app';
const SOFT_WARNING_ML = 2000;

interface SeededPatient {
  readonly patientId: string;
  readonly subject: string;
  readonly token: string;
}

/**
 * Awaits a client call that must be refused, and hands back the `ApiError`
 * **narrowed**, never cast.
 *
 * The generated client signals failure by throwing, so its `create()` is
 * typed `Promise<ObservationCreateResponse>` with no error arm in the return
 * type. Reaching for `.catch(...)` to inspect the rejection is what produces
 * `ObservationCreateResponse | ApiError` — `Promise.catch`'s result unions
 * the handler's return with the original resolution — and no cast inside the
 * handler removes that union, because the union is created by `.catch`
 * itself, one level out. A cast there would also assert something untrue:
 * `.catch` genuinely can hand back a success value if the call unexpectedly
 * succeeds, which is precisely the failure a test must not paper over.
 *
 * `try`/`await`/`catch` with an `instanceof` narrowing keeps both properties:
 * the success path is an explicit test failure, and a rejection that is not
 * an `ApiError` (a network fault, a `MissingAccessTokenError`) is rethrown
 * rather than silently asserted against.
 */
async function captureApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (caught) {
    if (caught instanceof ApiError) {
      return caught;
    }
    throw caught;
  }
  throw new Error('Expected the request to be refused, but it succeeded.');
}

/**
 * Everything the application logger emits during the capture block below.
 *
 * pino's default destination is a `SonicBoom` on file descriptor 1 and
 * writes through `fs.write`, not `process.stdout.write` — so spying on
 * `process.stdout` captures nothing and would produce a test that passes by
 * observing an empty buffer. The logger is given a real in-memory stream
 * instead, and `assertCaptureIsLive()` refuses to let the assertions run
 * against an empty capture.
 */
const capturedLogLines: string[] = [];
const logCaptureStream = new PassThrough();
logCaptureStream.on('data', (chunk: Buffer | string) => {
  capturedLogLines.push(String(chunk));
});

let captureFlushCounter = 0;

/**
 * Everything logged so far, with nothing still in flight.
 *
 * pino writes to the stream synchronously, but the `data` event that appends
 * to `capturedLogLines` is delivered on a later tick — so reading the array
 * straight after a request races the logger and silently drops the most
 * recently written line. That is the worst possible line to drop here: on an
 * error path it is the one carrying the exception. Observed, not theorised —
 * an assertion that the 500's error line had been logged failed against a
 * capture holding only the request-completed line written a millisecond
 * later.
 *
 * A fixed sleep would paper over it. A marker does not: the stream preserves
 * write order, so once the marker has been delivered, every line written
 * before it has been too.
 */
async function flushCapturedLogs(): Promise<string> {
  captureFlushCounter += 1;
  const marker = `<<capture-flush-${captureFlushCounter}>>`;
  logCaptureStream.write(`${marker}\n`);

  const deadline = Date.now() + 5_000;
  for (;;) {
    const text = capturedLogLines.join('');
    if (text.includes(marker)) {
      return text;
    }
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for the log capture stream to flush.');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * `LoggingModule` with its output redirected, and nothing else changed.
 *
 * The serializers and both redaction lists are imported from the
 * application's own source, so what is under test is the real filtering.
 * Only three values are restated — `level`, `autoLogging`, `censor` — and
 * `level` is deliberately `trace`, i.e. *more* is logged here than in any
 * real deployment. A leak that only appears at debug level is still a leak;
 * a PHI value that reached a log line at all is the defect, regardless of
 * whether the configured level would have emitted it that day.
 *
 * This is swapped in for the **whole suite's** application, not for a second
 * app built just for the logging tests, and that is forced rather than
 * chosen: `nestjs-pino`'s root logger is a module-scoped lazy singleton
 * (`ensureLoggerMiddleware` in `nestjs-pino/dist/rootLogger.js` — "called on
 * first use, whoever gets there first"). Whichever Nest application boots
 * first in a process pins the pino instance for every application built
 * afterwards, so a later app configured with a capture stream silently keeps
 * writing to the first one's destination. A capture set up that way records
 * nothing and every "does not contain PHI" assertion passes vacuously — which
 * is exactly what happened here before `assertCaptureIsLive()` caught it.
 * The library exports a `resetRootLogger()` for this, but not publicly (it is
 * absent from `dist/index.d.ts` and the package publishes no deep-import
 * subpath), so reaching for it would mean depending on a private path.
 */
@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: [
        {
          level: 'trace',
          autoLogging: true,
          // Must mirror LoggingModule's own genReqId. This module duplicates
          // that config rather than extending it, so a production change
          // lands here only if someone remembers — and the correlation-id
          // assertion below is testing the real column, so a stale copy here
          // would have it asserting against pino-http's default counter
          // while production wrote UUIDs.
          genReqId: () => randomUUID(),
          redact: {
            paths: [...CREDENTIAL_REDACTION_PATHS, ...PHI_SHAPED_REDACTION_PATHS],
            censor: '[REDACTED]',
          },
          serializers: { req: reqSerializer, res: resSerializer, err: errSerializer },
        },
        logCaptureStream,
      ],
    }),
  ],
  exports: [PinoLoggerModule],
})
class CapturingLoggingModule {}

describe.skipIf(!dockerAvailable)('P2.S1a — POST/GET /api/v1/observations', () => {
  let container: StartedPostgreSqlContainer;
  let runtimeDatabaseUrl: string;
  let db: PgClient;
  let issuer: TestOidcIssuer;
  let app: INestApplication;
  let baseUrl: string;

  let patientA: SeededPatient;
  let patientB: SeededPatient;
  let imperialPatient: SeededPatient;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('ostomy_observations_test')
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
      // Clinical thresholds are admin-managed configuration, never constants
      // in code — seeded here the way a real deploy's seed script would, by
      // the owner role.
      await owner.query(
        `INSERT INTO validation_thresholds (id, threshold_key, tier, value, unit, updated_at)
         VALUES
           (gen_random_uuid(), $1, 'TIER_2_SOFT_WARNING', $3, 'mL', now()),
           (gen_random_uuid(), $2, 'OPERATIONAL', 300, 'seconds', now())
           ON CONFLICT (threshold_key) DO UPDATE SET
             tier = EXCLUDED.tier, value = EXCLUDED.value,
             unit = EXCLUDED.unit, updated_at = EXCLUDED.updated_at`,
        [
          THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML,
          THRESHOLD_KEY.SYNC_CLOCK_SKEW_ALLOWANCE_SECONDS,
          SOFT_WARNING_ML,
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
      // Every request this suite makes is logged, at `trace`, into a stream
      // the "No PHI in application logs" block inspects. See
      // `CapturingLoggingModule` for why it has to be the first app's
      // logger and cannot be a second app's.
      .overrideModule(LoggingModule)
      .useModule(CapturingLoggingModule)
      .compile();

    app = moduleRef.createNestApplication();
    // Exactly what `main.ts` does, and load-bearing for the "No PHI in
    // application logs" block: without it Nest's own `ExceptionsHandler`
    // logs an unhandled exception through the default console logger,
    // bypassing `errSerializer` and the redaction lists entirely. A harness
    // that omits it would show a clean pino capture for a 500 while the real
    // process printed the whole error somewhere else.
    app.useLogger(app.get(PinoNestLogger));
    app.setGlobalPrefix('api/v1');
    // A real listener, because the generated client speaks HTTP to a URL
    // rather than to a supertest handle.
    await app.listen(0);
    baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

    patientA = await seedPatient('METRIC');
    patientB = await seedPatient('METRIC');
    imperialPatient = await seedPatient('IMPERIAL');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await container?.stop();
  });

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

  /**
   * Seeds a patient and profile as the **runtime** role, which is what a
   * future onboarding endpoint will do. If the grant model ever stopped
   * permitting that, this suite would fail here rather than silently proving
   * something about a more privileged connection.
   */
  async function seedPatient(measurementSystem: 'METRIC' | 'IMPERIAL'): Promise<SeededPatient> {
    const patientId = randomUUID();
    const subject = `patient-${randomUUID()}`;
    await db.query(`INSERT INTO patients (id, oidc_subject, updated_at) VALUES ($1, $2, now())`, [
      patientId,
      subject,
    ]);
    await db.query(
      `INSERT INTO profiles (id, patient_id, ostomy_type, surgery_date, measurement_system, client_updated_at, updated_at)
       VALUES ($1, $2, 'ILEOSTOMY', DATE '2026-01-15', $3, now(), now())`,
      [randomUUID(), patientId, measurementSystem],
    );
    const token = await issuer.sign({ issuer: ISSUER, audience: AUDIENCE, subject });
    return { patientId, subject, token };
  }

  function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      resourceType: 'Observation',
      id: randomUUID(),
      status: 'final',
      code: '79560-9',
      valueQuantity: { value: 350.5, unit: 'mL' },
      effectiveDateTime: '2026-09-07T14:00:00.000Z',
      method: null,
      enteredMeasurementSystem: 'metric',
      enteredTimezone: 'America/Chicago',
      ...overrides,
    };
  }

  function post(patient: SeededPatient, body: unknown) {
    return request(app.getHttpServer())
      .post('/api/v1/observations')
      .set('Authorization', `Bearer ${patient.token}`)
      .send(body as object);
  }

  async function observationRows(id: string): Promise<Array<Record<string, unknown>>> {
    const result = await db.query(`SELECT * FROM observations WHERE id = $1`, [id]);
    return result.rows;
  }

  async function auditRows(entityId: string): Promise<Array<Record<string, unknown>>> {
    const result = await db.query(
      `SELECT actor_type, actor_id, action, entity_type, entity_id, reason_code, correlation_id,
              before_value, after_value, occurred_at
       FROM audit_events WHERE entity_id = $1 ORDER BY occurred_at`,
      [entityId],
    );
    return result.rows;
  }

  // -------------------------------------------------------------------------

  describe('AC 2.1 AC 1 — positive decimals accepted; negative, zero and non-numeric rejected', () => {
    it('accepts a positive decimal and stores it at the entered precision', async () => {
      const body = validPayload({ valueQuantity: { value: 350.5, unit: 'mL' } });
      const response = await post(patientA, body);

      expect(response.status).toBe(201);
      expect(response.body.observation.valueQuantity).toEqual({ value: 350.5, unit: 'mL' });

      const rows = await observationRows(body.id as string);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.value_quantity_value)).toBe(350.5);
    });

    it("stores a value at the column's full scale without rounding it", async () => {
      // The precision claim is only tested at the boundary. One decimal
      // place would pass even if the column were DECIMAL(12,1).
      const body = validPayload({ valueQuantity: { value: 350.1234, unit: 'mL' } });
      const response = await post(patientA, body);

      expect(response.status).toBe(201);
      expect(response.body.observation.valueQuantity.value).toBe(350.1234);
      expect(Number((await observationRows(body.id as string))[0]!.value_quantity_value)).toBe(
        350.1234,
      );
    });

    it.each([
      ['a negative volume', -1, 'VALUE_NOT_POSITIVE'],
      ['zero', 0, 'VALUE_NOT_POSITIVE'],
    ])('rejects %s with %s and writes nothing', async (_label, value, reasonCode) => {
      const body = validPayload({ valueQuantity: { value, unit: 'mL' } });
      const response = await post(patientA, body);

      expect(response.status).toBe(422);
      expect(response.body.error.errors).toContainEqual({
        field: 'valueQuantity.value',
        reasonCode,
      });
      expect(await observationRows(body.id as string)).toHaveLength(0);
      expect(await auditRows(body.id as string)).toHaveLength(0);
    });

    it.each([
      ['a string', 'three hundred'],
      ['null', null],
      ['an object', { value: 350 }],
      ['a missing key', undefined],
    ])('rejects %s as VALUE_NOT_NUMERIC', async (_label, value) => {
      const valueQuantity = value === undefined ? { unit: 'mL' } : { value, unit: 'mL' };
      const body = validPayload({ valueQuantity });
      const response = await post(patientA, body);

      expect(response.status).toBe(422);
      expect(response.body.error.errors).toContainEqual({
        field: 'valueQuantity.value',
        reasonCode: 'VALUE_NOT_NUMERIC',
      });
      expect(await observationRows(body.id as string)).toHaveLength(0);
    });
  });

  /**
   * These four inputs pass every other Tier 1 rule and used to reach
   * Postgres, where they failed as `numeric field overflow` or as a
   * positivity-CHECK violation after rounding to `0.0000`. Neither is a
   * Prisma `P2002`, so both surfaced as HTTP 500 — and §9 tells a client to
   * treat a 5xx as an unknown outcome and re-push. A mistyped volume
   * therefore retried forever and never reached the correction inbox.
   *
   * The assertion that matters in each case is `422`, not merely
   * "not 201": a 500 here would still write nothing, so a
   * `toHaveLength(0)` check alone would pass against the exact defect
   * this block exists to prevent.
   */
  describe('values the canonical column cannot hold are correctable rejections, not 500s', () => {
    it.each([
      ['a magnitude past DECIMAL(12,4)', 123456789, 'VALUE_EXCEEDS_MAX_MAGNITUDE'],
      ['exactly 10^8', 100000000, 'VALUE_EXCEEDS_MAX_MAGNITUDE'],
      ['more decimal places than the column keeps', 350.12345, 'VALUE_EXCEEDS_MAX_PRECISION'],
      ['a sub-scale value that would round to zero', 0.00004, 'VALUE_EXCEEDS_MAX_PRECISION'],
    ])('rejects %s with %s and writes nothing', async (_label, value, reasonCode) => {
      const body = validPayload({ valueQuantity: { value, unit: 'mL' } });
      const response = await post(patientA, body);

      expect(response.status).toBe(422);
      expect(response.body.error.errors).toContainEqual({
        field: 'valueQuantity.value',
        reasonCode,
      });
      expect(await observationRows(body.id as string)).toHaveLength(0);
      expect(await auditRows(body.id as string)).toHaveLength(0);
    });

    it('accepts the boundary values on the legal side, so the rule cannot have narrowed what a patient may log', async () => {
      for (const value of [99999999.9999, 350.1234, 0.0001]) {
        const body = validPayload({ valueQuantity: { value, unit: 'mL' } });
        await post(patientA, body).expect(201);
        expect(Number((await observationRows(body.id as string))[0]!.value_quantity_value)).toBe(
          value,
        );
      }
    });
  });

  describe('AC 2.1 AC 2 — above the soft-warning threshold warns and SAVES', () => {
    it('returns 201 with a Tier 2 warning, and the row is there afterwards', async () => {
      const body = validPayload({ valueQuantity: { value: 2500, unit: 'mL' } });
      const response = await post(patientA, body);

      expect(response.status).toBe(201);
      expect(response.body.warnings).toEqual([
        { field: 'valueQuantity.value', ruleCode: 'VALUE_ABOVE_TYPICAL_RANGE' },
      ]);

      // The point of the criterion: a real 2,500 mL day is the entry the
      // care team most needs, so the assertion that matters is the row.
      const rows = await observationRows(body.id as string);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]!.value_quantity_value)).toBe(2500);
      expect(await auditRows(body.id as string)).toHaveLength(1);
    });

    it('reads the threshold from validation_thresholds rather than a constant', async () => {
      // Lower the admin-managed threshold and watch a previously-clean value
      // start warning, with no deploy and no code change.
      const owner = new PgClient({ connectionString: container.getConnectionUri() });
      await owner.connect();
      try {
        await owner.query(`UPDATE validation_thresholds SET value = 300 WHERE threshold_key = $1`, [
          THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML,
        ]);
      } finally {
        await owner.end();
      }

      // The service caches thresholds; a fresh app instance is the honest way
      // to observe the new row without reaching into the cache.
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule.register(testConfig())],
      })
        .overrideProvider(PATIENT_JWKS_RESOLVER)
        .useValue(issuer.getKey)
        .compile();
      const freshApp = moduleRef.createNestApplication();
      freshApp.setGlobalPrefix('api/v1');
      await freshApp.init();

      try {
        const body = validPayload({ valueQuantity: { value: 400, unit: 'mL' } });
        const response = await request(freshApp.getHttpServer())
          .post('/api/v1/observations')
          .set('Authorization', `Bearer ${patientA.token}`)
          .send(body);

        expect(response.status).toBe(201);
        expect(response.body.warnings).toHaveLength(1);
      } finally {
        await freshApp.close();
        const owner2 = new PgClient({ connectionString: container.getConnectionUri() });
        await owner2.connect();
        await owner2.query(`UPDATE validation_thresholds SET value = $2 WHERE threshold_key = $1`, [
          THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML,
          SOFT_WARNING_ML,
        ]);
        await owner2.end();
      }
    });
  });

  describe('AC 2.2 AC 1 — a missing Measured/Estimated selection blocks the write', () => {
    it('rejects a payload with no method key at all', async () => {
      const body = validPayload();
      delete body.method;

      const response = await post(patientA, body);

      expect(response.status).toBe(422);
      expect(response.body.error.errors).toContainEqual({
        field: 'method',
        reasonCode: 'METHOD_REQUIRED',
      });
      expect(await observationRows(body.id as string)).toHaveLength(0);
    });

    /**
     * ADR-0018 (amended). `null` stays accepted, because §8 requires
     * understanding a client built before the amendment — but the stored row
     * carries the explicit qualifier, so the wire's ambiguity never becomes a
     * row's ambiguity. This asserts the normalisation end to end, against
     * real PostgreSQL, which is the only place it can actually be proven.
     */
    it('accepts an explicit null as "measured" and stores the |Measured| code', async () => {
      const body = validPayload({ method: null });
      const response = await post(patientA, body);

      expect(response.status).toBe(201);
      const rows = await observationRows(body.id as string);
      expect(rows[0]!.method).toBe('258104002');
    });

    it('accepts the explicit |Measured| code and stores it unchanged', async () => {
      const body = validPayload({ method: '258104002' });
      const response = await post(patientA, body);

      expect(response.status).toBe(201);
      const rows = await observationRows(body.id as string);
      expect(rows[0]!.method).toBe('258104002');
    });
  });

  /**
   * AC 12.1 — voided urine, the first entry type that may record NO AMOUNT.
   *
   * Everything about this feature lives in places a unit test cannot reach:
   * four CHECK constraints in the P3.S2 migration, a nullable clinical column,
   * and a service that picks between two validation engines. The unit tests
   * prove the parse and the rule choice; only this proves that a colour-only
   * entry actually lands in PostgreSQL and that the combinations the
   * constraints forbid are refused as CORRECTABLE rejections rather than as
   * constraint-violation 500s — which `docs/sync-contract.md` §9 tells a
   * client to re-push indefinitely, so a bad entry would retry forever
   * instead of reaching the patient's correction inbox.
   */
  describe('AC 12.1 — voided urine, including an entry with no volume', () => {
    function urinePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
      return validPayload({ code: '9187-6', ...overrides });
    }

    /** AC 12.1 AC1 — with an amount, identical treatment to any other volumetric entry. */
    it('accepts a measured urine entry with a volume and a colour', async () => {
      const body = urinePayload({
        valueQuantity: { value: 275, unit: 'mL' },
        method: '258104002',
        urineColorCode: 'straw',
      });

      const response = await post(patientA, body);

      expect(response.status).toBe(201);
      expect(response.body.observation.valueQuantity).toEqual({ value: 275, unit: 'mL' });
      expect(response.body.observation.urineColorCode).toBe('straw');

      const rows = await observationRows(body.id as string);
      expect(rows[0]).toMatchObject({
        code: '9187-6',
        value_quantity_unit: 'mL',
        urine_color_code: 'straw',
        method: '258104002',
      });
    });

    /**
     * AC 12.1 AC2, and the entry this whole sprint exists for: a patient who
     * cannot measure records a colour alone, and it is retained as a valid
     * hydration observation.
     */
    it('accepts a colour with no volume at all, and stores NULL rather than zero', async () => {
      const body = urinePayload({ urineColorCode: 'amber' });
      delete body.valueQuantity;
      delete body.method;

      const response = await post(patientA, body);

      expect(response.status).toBe(201);
      const rows = await observationRows(body.id as string);
      expect(rows).toHaveLength(1);
      // NULL, never 0. `SUM()` skips NULL; application code that reads a
      // missing value as 0 does not, and the two disagree in every daily total
      // forever afterwards.
      expect(rows[0]!.value_quantity_value).toBeNull();
      // The pair travels together — `observations_volume_with_unit`.
      expect(rows[0]!.value_quantity_unit).toBeNull();
      expect(rows[0]!.urine_color_code).toBe('amber');
      // ADR-0018 (amended): with no number, NULL is what says "no toggle".
      expect(rows[0]!.method).toBeNull();
    });

    /** §7.2: `valueQuantity` is omitted from the response too, never sent as null. */
    it('omits valueQuantity from the published resource when there is none', async () => {
      const body = urinePayload({ urineColorCode: 'pale_straw' });
      delete body.valueQuantity;
      delete body.method;

      const response = await post(patientA, body);

      expect(response.status).toBe(201);
      expect('valueQuantity' in response.body.observation).toBe(false);
    });

    /**
     * ADR-0012 is unchanged by the absence of a volume: it is the client's
     * assertion about the ENTRY, not a property of the number, and the column
     * is NOT NULL with no default.
     */
    it('still requires the entered measurement system on a colour-only entry', async () => {
      const body = urinePayload({ urineColorCode: 'amber' });
      delete body.valueQuantity;
      delete body.method;
      delete body.enteredMeasurementSystem;

      const response = await post(patientA, body);

      expect(response.status).toBe(400);
      expect(await observationRows(body.id as string)).toHaveLength(0);
    });

    it('refuses a urine entry carrying neither a volume nor a colour', async () => {
      const body = urinePayload();
      delete body.valueQuantity;
      delete body.method;

      const response = await post(patientA, body);

      // It would record nothing at all. Refused by the application, so the
      // patient gets a field to act on — `observations_value_or_urine_color`
      // would refuse it too, as a 500 nothing can correct.
      expect(response.status).toBe(400);
      expect(await observationRows(body.id as string)).toHaveLength(0);
    });

    it('refuses a Measured/Estimated qualifier on an entry with no volume', async () => {
      const body = urinePayload({ urineColorCode: 'amber', method: '258104002' });
      delete body.valueQuantity;

      const response = await post(patientA, body);

      expect(response.status).toBe(422);
      expect(response.body.error.errors).toContainEqual({
        field: 'method',
        reasonCode: 'METHOD_NOT_APPLICABLE',
      });
      expect(await observationRows(body.id as string)).toHaveLength(0);
    });

    /**
     * Only voided urine may omit the volume. A stoma output row with no
     * volume is the defect the whole nullable-column change risks
     * introducing, and this is the assertion that it stays unwritable.
     */
    it('refuses a stoma output entry with no volume', async () => {
      const body = validPayload();
      delete body.valueQuantity;

      const response = await post(patientA, body);

      expect(response.status).toBe(400);
      expect(await observationRows(body.id as string)).toHaveLength(0);
    });

    /**
     * A colour on a stoma output row would render as a hydration signal for
     * the wrong observation. `observations_urine_color_only_on_urine` forbids
     * it in the database as well; this proves the application refuses it
     * first, with a field the patient can act on.
     */
    it('refuses a colour on any code other than voided urine', async () => {
      const body = validPayload({ urineColorCode: 'amber' });

      const response = await post(patientA, body);

      expect(response.status).toBe(400);
      expect(await observationRows(body.id as string)).toHaveLength(0);
    });

    /**
     * The server does NOT check value-set membership, deliberately and for the
     * reason `fluidTypeCode` records: an unknown code renders as a generic
     * label and is recoverable; a refused entry is not. A member an admin adds
     * after this release ships is a real case, not a hypothetical.
     */
    it('accepts a colour code this build has never heard of', async () => {
      const body = urinePayload({ urineColorCode: 'very_dark_brown' });
      delete body.valueQuantity;
      delete body.method;

      const response = await post(patientA, body);

      expect(response.status).toBe(201);
      const rows = await observationRows(body.id as string);
      expect(rows[0]!.urine_color_code).toBe('very_dark_brown');
    });

    /** The value set the screen reads its codes from is seeded by the migration, not by packages/seed. */
    it('seeds the urine_color value set with its six steps, pale to dark', async () => {
      const result = await db.query(
        `SELECT m.code, m.sort_order, m.status
         FROM value_set_members m
         JOIN value_sets vs ON vs.id = m.value_set_id
         WHERE vs.key = 'urine_color'
         ORDER BY m.sort_order`,
      );

      expect(result.rows.map((row) => row.code)).toEqual([
        'pale_straw',
        'straw',
        'yellow',
        'dark_yellow',
        'amber',
        'brown',
      ]);
      expect(result.rows.every((row) => row.status === 'ACTIVE')).toBe(true);
    });

    /**
     * A colour-only entry is PHI like any other, so it audits like any other.
     * Worth asserting separately: the write takes a different branch of the
     * service, and an audit row written inside the volumetric branch only
     * would leave this entry type silently unaudited.
     */
    it('writes exactly one audit row for a colour-only entry', async () => {
      const body = urinePayload({ urineColorCode: 'amber' });
      delete body.valueQuantity;
      delete body.method;

      expect((await post(patientA, body)).status).toBe(201);

      const audit = await auditRows(body.id as string);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ action: 'CREATE', entity_type: OBSERVATION_ENTITY_TYPE });
    });
  });

  describe('AC 2.5 AC 1 — FHIR field names on the wire', () => {
    /**
     * P3.S1 (SRS AC 2.3). Intake is the second accepted LOINC code and the
     * first to carry `fluidTypeCode`, so this is the end-to-end proof that a
     * widened accepted-code set actually writes and reads back — not just
     * that the payload interpreter allows it.
     */
    it('accepts a fluid-intake entry with its optional categorisation and stores both', async () => {
      const response = await post(patientA, {
        ...validPayload(),
        code: '9000-1',
        fluidTypeCode: 'oral_rehydration_solution',
      });

      expect(response.status).toBe(201);
      expect(response.body.observation.code).toBe('9000-1');
      expect(response.body.observation.fluidTypeCode).toBe('oral_rehydration_solution');
    });

    it('accepts an intake entry with no categorisation, which AC 2.3 AC1 makes optional', async () => {
      const response = await post(patientA, { ...validPayload(), code: '9000-1' });

      expect(response.status).toBe(201);
      expect(response.body.observation.fluidTypeCode).toBeNull();
    });

    it('refuses a categorisation on stoma output, naming the field the patient can see', async () => {
      const response = await post(patientA, { ...validPayload(), fluidTypeCode: 'water' });

      // 400, matching every other PAYLOAD_FIELD_INVALID on this surface
      // (`method`, `enteredMeasurementSystem`): a recognized field carrying a
      // value outside its domain is a content problem, and this endpoint
      // reports that class as 400.
      expect(response.status).toBe(400);
      expect(response.body.error.errors).toEqual([
        { field: 'fluidTypeCode', reasonCode: 'PAYLOAD_FIELD_INVALID' },
      ]);
    });

    it('accepts the payload docs/sync-contract.md §7.2 spells out, and echoes it back', async () => {
      const body = validPayload();
      const response = await post(patientA, body);

      expect(response.status).toBe(201);
      expect(Object.keys(response.body.observation).sort()).toEqual(
        [
          'code',
          'effectiveDateTime',
          'enteredMeasurementSystem',
          'enteredTimezone',
          'id',
          'method',
          'resourceType',
          'status',
          'valueQuantity',
          // P3.S1. Always present and `null` when there is none, never
          // omitted — an absent key and a null one read the same to a human
          // and differently to a client, which is §7.2's own argument for
          // `method`.
          'fluidTypeCode',
        ].sort(),
      );
      expect(response.body.observation.resourceType).toBe('Observation');
      expect(response.body.observation.effectiveDateTime).toBe('2026-09-07T14:00:00.000Z');

      // The database columns map 1:1 onto those FHIR names.
      const row = (await observationRows(body.id as string))[0]!;
      expect(row.resource_type).toBe('Observation');
      expect(row.value_quantity_unit).toBe('mL');
      expect((row.effective_datetime as Date).toISOString()).toBe('2026-09-07T14:00:00.000Z');
    });

    it('refuses a non-FHIR spelling of the same data rather than accepting both', async () => {
      const response = await post(patientA, {
        resourceType: 'Observation',
        id: randomUUID(),
        status: 'final',
        code: '79560-9',
        // A plausible custom schema someone might map to FHIR "later".
        volumeMl: 350,
        recordedAt: '2026-09-07T14:00:00.000Z',
        method: null,
        enteredMeasurementSystem: 'metric',
        enteredTimezone: 'America/Chicago',
      });

      expect(response.status).toBe(400);
      expect(response.body.error.errors[0].reasonCode).toMatch(
        /PAYLOAD_FIELD_(INVALID|UNRECOGNIZED)/,
      );
    });
  });

  describe('AC 2.5 AC 2 — method, and the D4 gap', () => {
    it('refuses any non-null method while the SNOMED code is unresolved (§7.2)', async () => {
      const body = validPayload({ method: '373067005' });
      const response = await post(patientA, body);

      expect(response.status).toBe(400);
      expect(response.body.error.errors).toEqual([
        { field: 'method', reasonCode: 'PAYLOAD_FIELD_INVALID' },
      ]);
      expect(await observationRows(body.id as string)).toHaveLength(0);
    });
  });

  describe('AC 13.1 AC 3 — every rule is re-enforced server-side', () => {
    it('rejects a payload no client-side check would ever produce', async () => {
      // Deliberately several rules at once, all of them things a client is
      // supposed to have caught: a future clinical moment, no method
      // selection, and a negative volume.
      const body = validPayload({
        valueQuantity: { value: -5, unit: 'mL' },
        effectiveDateTime: new Date(Date.now() + 90 * 24 * 3600 * 1000)
          .toISOString()
          .replace(/\.\d{3}Z$/, '.000Z'),
      });
      delete body.method;

      const response = await post(patientA, body);

      expect(response.status).toBe(422);
      const codes = (response.body.error.errors as Array<{ reasonCode: string }>).map(
        (detail) => detail.reasonCode,
      );
      expect(codes).toEqual(
        expect.arrayContaining([
          'VALUE_NOT_POSITIVE',
          'METHOD_REQUIRED',
          'EFFECTIVE_DATE_TIME_IN_FUTURE',
        ]),
      );
      expect(await observationRows(body.id as string)).toHaveLength(0);
    });

    it('rejects a clinical moment before the surgery date', async () => {
      const body = validPayload({ effectiveDateTime: '2025-12-01T10:00:00.000Z' });
      const response = await post(patientA, body);

      expect(response.status).toBe(422);
      expect(response.body.error.errors).toContainEqual({
        field: 'effectiveDateTime',
        reasonCode: 'EFFECTIVE_DATE_TIME_BEFORE_SURGERY',
      });
    });

    it('never echoes the offending clinical value in a rejection (§6.3)', async () => {
      const body = validPayload({ valueQuantity: { value: -9997, unit: 'mL' } });
      const response = await post(patientA, body);

      expect(JSON.stringify(response.body)).not.toContain('9997');
    });
  });

  describe("ADR-0012 (as amended at P2.S1a) — entered_measurement_system is the CLIENT's asserted entry system", () => {
    it('stores the asserted system, NOT NULL, on every row', async () => {
      const metric = validPayload();
      await post(patientA, metric).expect(201);
      expect((await observationRows(metric.id as string))[0]!.entered_measurement_system).toBe(
        'METRIC',
      );

      const imperial = validPayload({ enteredMeasurementSystem: 'imperial' });
      await post(imperialPatient, imperial).expect(201);
      expect((await observationRows(imperial.id as string))[0]!.entered_measurement_system).toBe(
        'IMPERIAL',
      );
    });

    it("stores what the client asserted even when it disagrees with the patient's CURRENT profile — the offline case this column exists for", async () => {
      // patientA's profile is metric. This is the patient who entered three
      // days offline in imperial and then switched: the queued payload is
      // the only record of what they actually typed, and re-deriving from
      // the (now metric) profile would attribute it to a system they never
      // used. ADR-0012's amendment and docs/sync-contract.md §7.2.
      const body = validPayload({ enteredMeasurementSystem: 'imperial' });

      await post(patientA, body).expect(201);

      expect((await observationRows(body.id as string))[0]!.entered_measurement_system).toBe(
        'IMPERIAL',
      );
      // And the profile is untouched — this write records an entry system,
      // it does not change the patient's preference.
      const profile = await db.query(
        `SELECT measurement_system FROM profiles WHERE patient_id = $1`,
        [patientA.patientId],
      );
      expect(profile.rows[0]!.measurement_system).toBe('METRIC');
    });

    it('still refuses a system that is neither metric nor imperial — the one domain check §6.2 defines for this field', async () => {
      const body = validPayload({ enteredMeasurementSystem: 'nautical' });
      const response = await post(patientA, body);

      expect(response.status).toBe(400);
      expect(response.body.error.errors).toEqual([
        { field: 'enteredMeasurementSystem', reasonCode: 'PAYLOAD_FIELD_INVALID' },
      ]);
      expect(await observationRows(body.id as string)).toHaveLength(0);
    });
  });

  describe("Ownership authorization — a valid token must not reach another patient's row", () => {
    it("does not return another patient's row by id, and does not reveal that it exists", async () => {
      const body = validPayload();
      await post(patientB, body).expect(201);

      const asOwner = await request(app.getHttpServer())
        .get(`/api/v1/observations/${body.id as string}`)
        .set('Authorization', `Bearer ${patientB.token}`);
      expect(asOwner.status).toBe(200);

      const asOther = await request(app.getHttpServer())
        .get(`/api/v1/observations/${body.id as string}`)
        .set('Authorization', `Bearer ${patientA.token}`);
      const neverExisted = await request(app.getHttpServer())
        .get(`/api/v1/observations/${randomUUID()}`)
        .set('Authorization', `Bearer ${patientA.token}`);

      expect(asOther.status).toBe(404);
      // Byte-identical: the response to "someone else's row" and the response
      // to "no such row" must not differ in any way a caller could measure.
      expect(asOther.body).toEqual(neverExisted.body);
    });

    it("never lists another patient's rows", async () => {
      const bodyB = validPayload();
      await post(patientB, bodyB).expect(201);

      const listA = await request(app.getHttpServer())
        .get('/api/v1/observations')
        .set('Authorization', `Bearer ${patientA.token}`);

      expect(listA.status).toBe(200);
      const ids = (listA.body.observations as Array<{ id: string }>).map((o) => o.id);
      expect(ids).not.toContain(bodyB.id);

      const rowsForA = await db.query(
        `SELECT id FROM observations WHERE patient_id = $1 AND deleted_at IS NULL`,
        [patientA.patientId],
      );
      // Every id returned belongs to patient A, and the list is not simply
      // empty for an unrelated reason — an empty list would satisfy
      // "contains none of B's" while proving nothing.
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(rowsForA.rows.some((row) => row.id === id)).toBe(true);
      }
    });

    it("cannot overwrite another patient's row by reusing its id, and says the same thing either way", async () => {
      const bodyB = validPayload({ valueQuantity: { value: 111, unit: 'mL' } });
      await post(patientB, bodyB).expect(201);

      const collision = await post(
        patientA,
        validPayload({ id: bodyB.id, valueQuantity: { value: 999, unit: 'mL' } }),
      );
      const ownDuplicate = await post(patientB, validPayload({ id: bodyB.id }));

      expect(collision.status).toBe(409);
      expect(ownDuplicate.status).toBe(409);
      expect(collision.body).toEqual(ownDuplicate.body);

      // The stored row is untouched, and still belongs to B.
      const rows = await observationRows(bodyB.id as string);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.patient_id).toBe(patientB.patientId);
      expect(Number(rows[0]!.value_quantity_value)).toBe(111);
    });

    it('refuses a token whose subject has no patient record', async () => {
      const orphanToken = await issuer.sign({
        issuer: ISSUER,
        audience: AUDIENCE,
        subject: `never-onboarded-${randomUUID()}`,
      });
      const response = await request(app.getHttpServer())
        .post('/api/v1/observations')
        .set('Authorization', `Bearer ${orphanToken}`)
        .send(validPayload());

      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe('PATIENT_NOT_PROVISIONED');
    });

    it('rejects an unauthenticated request before any of this', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/observations')
        .send(validPayload());
      expect(response.status).toBe(401);
    });
  });

  describe('Audit coverage — every PHI write produces exactly one audit row', () => {
    it('records actor, correlation id and before/after, in the same transaction as the write', async () => {
      const body = validPayload({ valueQuantity: { value: 425, unit: 'mL' } });
      const response = await post(patientA, body);
      expect(response.status).toBe(201);

      const rows = await auditRows(body.id as string);
      // Exactly one: the handler writes it inside the observation's
      // transaction and stages it as already-committed, so the global
      // interceptor counts it for coverage without writing a duplicate into
      // a table that has no DELETE grant to fix one.
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row).toMatchObject({
        actor_type: 'PATIENT',
        actor_id: patientA.subject,
        action: 'CREATE',
        entity_type: 'observation',
        entity_id: body.id,
        reason_code: 'direct_write',
      });

      // The correlation id lives in its own indexed column, not nested in
      // the JSON — "reconstruct everything that happened in request X" runs
      // under a breach-notification clock.
      // A UUID, not pino-http's default per-process counter. `expect.any(String)`
      // plus a length check passed against "1", which is what this column held
      // before the P2.S1a review: unique per process, colliding across tasks,
      // and reset on restart — useless as the join key a breach-notification
      // determination needs.
      expect(row.correlation_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      );

      // Before/after are the entity's own fields. A create has no before.
      expect(row.before_value).toBeNull();
      expect(row.after_value).toMatchObject({
        id: body.id,
        code: '79560-9',
        valueQuantityValue: 425,
        valueQuantityUnit: 'mL',
        enteredMeasurementSystem: 'METRIC',
        status: 'FINAL',
      });
      // Not a wrapper around the request body: no client-supplied key can
      // reach an append-only table.
      expect(Object.keys(row.after_value as object)).not.toContain('correlationId');
    });

    it('gives two separate requests two different correlation ids', async () => {
      // The counter this replaced was monotonic, so it also passed a
      // "two requests differ" check within one process. What it could not
      // do is stay unique across processes or survive a restart — hence the
      // UUID-shape assertion above rather than mere inequality here. Both
      // together are what make the column a usable join key.
      const first = validPayload();
      const second = validPayload();
      await post(patientA, first).expect(201);
      await post(patientA, second).expect(201);

      const firstId = (await auditRows(first.id as string))[0]!.correlation_id;
      const secondId = (await auditRows(second.id as string))[0]!.correlation_id;

      expect(firstId).not.toBe(secondId);
    });

    it('leaves no audit row behind when the write is refused', async () => {
      const body = validPayload({ valueQuantity: { value: -3, unit: 'mL' } });
      await post(patientA, body).expect(422);

      expect(await auditRows(body.id as string)).toHaveLength(0);
      expect(await observationRows(body.id as string)).toHaveLength(0);
    });

    it('keeps audit_events append-only for the runtime role while these writes happen (ADR-0011)', async () => {
      const body = validPayload();
      await post(patientA, body).expect(201);

      await expect(
        db.query(`UPDATE audit_events SET reason_code = 'tampered' WHERE entity_id = $1`, [
          body.id,
        ]),
      ).rejects.toMatchObject({ message: expect.stringContaining('permission denied') });
      await expect(
        db.query(`DELETE FROM audit_events WHERE entity_id = $1`, [body.id]),
      ).rejects.toMatchObject({ message: expect.stringContaining('permission denied') });
    });

    it('leaves no audit row behind when the write fails at COMMIT, after both inserts succeeded', async () => {
      // The discriminating test for `AuditService.record(context, tx)`, and
      // the reason it has to be this elaborate.
      //
      // Every other case in this block passes whether or not the audit write
      // shares the observation's transaction. A create that succeeds
      // produces both rows either way; a create refused by validation
      // produces neither; and a create whose *audit* insert fails aborts the
      // request either way, because that failure propagates. The two designs
      // diverge only when both inserts have already succeeded and the
      // transaction then fails — a serialization failure, a deferred
      // constraint, a connection lost between the last statement and the
      // COMMIT. Sharing the transaction discards both rows. A second
      // transaction has already committed the audit row, which then stands
      // as a permanent record of a clinical write that never happened, in a
      // table with no DELETE grant to remove it (ADR-0011).
      //
      // A DEFERRABLE INITIALLY DEFERRED constraint trigger is what makes
      // that reachable from a test: it fires at COMMIT, not at INSERT, so
      // both statements run normally first.
      const owner = new PgClient({ connectionString: container.getConnectionUri() });
      await owner.connect();
      const body = validPayload({ valueQuantity: { value: 512, unit: 'mL' } });
      try {
        await owner.query(`
          CREATE OR REPLACE FUNCTION commit_failure_probe() RETURNS trigger AS $probe$
          BEGIN
            RAISE EXCEPTION 'commit_failure_probe';
          END;
          $probe$ LANGUAGE plpgsql;
        `);
        await owner.query(`
          CREATE CONSTRAINT TRIGGER commit_failure_probe
          AFTER INSERT ON observations
          DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION commit_failure_probe();
        `);

        const response = await post(patientA, body);
        expect(response.status).toBe(500);
      } finally {
        await owner.query(`DROP TRIGGER IF EXISTS commit_failure_probe ON observations`);
        await owner.query(`DROP FUNCTION IF EXISTS commit_failure_probe()`);
        await owner.end();
      }

      // Neither row exists. With the audit write on its own transaction the
      // audit row would be here, describing a write nothing else records.
      expect(await observationRows(body.id as string)).toHaveLength(0);
      expect(await auditRows(body.id as string)).toHaveLength(0);

      // And the id is still free afterwards, so a client retrying the same
      // operation is not permanently blocked by a half-applied write.
      await post(patientA, body).expect(201);
      expect(await observationRows(body.id as string)).toHaveLength(1);
      expect(await auditRows(body.id as string)).toHaveLength(1);
    });

    it('audit row count equals write count across a run of mixed accepted and rejected writes', async () => {
      const accepted: string[] = [];
      const rejected: string[] = [];

      for (const value of [100, -1, 250, 0, 2500]) {
        const body = validPayload({ valueQuantity: { value, unit: 'mL' } });
        const response = await post(patientA, body);
        (response.status === 201 ? accepted : rejected).push(body.id as string);
      }

      expect(accepted).toHaveLength(3);
      expect(rejected).toHaveLength(2);

      for (const id of accepted) {
        expect(await auditRows(id)).toHaveLength(1);
      }
      for (const id of rejected) {
        expect(await auditRows(id)).toHaveLength(0);
      }
    });
  });

  describe('GET /api/v1/observations — listing', () => {
    /**
     * P3.S1b. This endpoint used to hardcode stoma output, which made Daily
     * Net Fluid Balance unobtainable from it by construction: the figure is
     * intake MINUS output, and a response carrying one side of a subtraction
     * cannot produce it. `apps/web` shipped an "unavailable" notice for
     * exactly that reason.
     */
    it('returns intake alongside output, so a balance is computable from one response', async () => {
      const patient = await seedPatient('METRIC');
      await request(app.getHttpServer())
        .post('/api/v1/observations')
        .set('Authorization', `Bearer ${patient.token}`)
        .send(validPayload())
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/observations')
        .set('Authorization', `Bearer ${patient.token}`)
        .send({ ...validPayload(), code: '9000-1' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get('/api/v1/observations')
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(200);

      const codes = (response.body.observations as Array<{ code: string }>).map((o) => o.code);
      expect(codes).toContain('79560-9');
      expect(codes).toContain('9000-1');
    });

    it('narrows to one code when asked', async () => {
      const patient = await seedPatient('METRIC');
      await request(app.getHttpServer())
        .post('/api/v1/observations')
        .set('Authorization', `Bearer ${patient.token}`)
        .send(validPayload())
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/observations')
        .set('Authorization', `Bearer ${patient.token}`)
        .send({ ...validPayload(), code: '9000-1' })
        .expect(201);

      const response = await request(app.getHttpServer())
        .get('/api/v1/observations?code=9000-1')
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(200);

      expect((response.body.observations as Array<{ code: string }>).map((o) => o.code)).toEqual([
        '9000-1',
      ]);
    });

    /**
     * Refused rather than ignored, for the reason the unrecognised-key rule
     * gives: a filter the server drops returns 200 with rows the caller did
     * not ask for, and a reader cannot tell that from the patient genuinely
     * having them.
     */
    it('refuses a code this release does not accept', async () => {
      const patient = await seedPatient('METRIC');

      await request(app.getHttpServer())
        .get('/api/v1/observations?code=29463-7')
        .set('Authorization', `Bearer ${patient.token}`)
        .expect(400);
    });

    it('orders by the clinical moment, most recent first, and filters by date range', async () => {
      const patient = await seedPatient('METRIC');
      const moments = [
        '2026-03-01T08:00:00.000Z',
        '2026-03-02T08:00:00.000Z',
        '2026-03-03T08:00:00.000Z',
      ];
      for (const effectiveDateTime of moments) {
        await request(app.getHttpServer())
          .post('/api/v1/observations')
          .set('Authorization', `Bearer ${patient.token}`)
          .send(validPayload({ effectiveDateTime }))
          .expect(201);
      }

      const all = await request(app.getHttpServer())
        .get('/api/v1/observations')
        .set('Authorization', `Bearer ${patient.token}`);
      expect(
        (all.body.observations as Array<{ effectiveDateTime: string }>).map(
          (o) => o.effectiveDateTime,
        ),
      ).toEqual([...moments].reverse());

      const windowed = await request(app.getHttpServer())
        .get('/api/v1/observations')
        .query({
          effectiveDateTimeFrom: '2026-03-02T00:00:00.000Z',
          effectiveDateTimeTo: '2026-03-02T23:59:59.999Z',
        })
        .set('Authorization', `Bearer ${patient.token}`);
      expect(windowed.body.observations).toHaveLength(1);
      expect(windowed.body.observations[0].effectiveDateTime).toBe(moments[1]);
    });

    it('honours limit and refuses a malformed one', async () => {
      const limited = await request(app.getHttpServer())
        .get('/api/v1/observations')
        .query({ limit: '1' })
        .set('Authorization', `Bearer ${patientA.token}`);
      expect(limited.body.observations).toHaveLength(1);

      const bad = await request(app.getHttpServer())
        .get('/api/v1/observations')
        .query({ limit: 'lots' })
        .set('Authorization', `Bearer ${patientA.token}`);
      expect(bad.status).toBe(400);
      expect(bad.body.error.errors).toEqual([
        { field: 'limit', reasonCode: 'PAYLOAD_FIELD_INVALID' },
      ]);
    });

    it('excludes tombstoned rows', async () => {
      const patient = await seedPatient('METRIC');
      const body = validPayload();
      await request(app.getHttpServer())
        .post('/api/v1/observations')
        .set('Authorization', `Bearer ${patient.token}`)
        .send(body)
        .expect(201);

      await db.query(`UPDATE observations SET deleted_at = now() WHERE id = $1`, [body.id]);

      const list = await request(app.getHttpServer())
        .get('/api/v1/observations')
        .set('Authorization', `Bearer ${patient.token}`);
      expect(list.body.observations).toHaveLength(0);

      const single = await request(app.getHttpServer())
        .get(`/api/v1/observations/${body.id as string}`)
        .set('Authorization', `Bearer ${patient.token}`);
      expect(single.status).toBe(404);
    });
  });

  describe('No PHI in application logs', () => {
    beforeAll(() => {
      // Re-applied, not merely applied once in the suite's own `beforeAll`.
      // `TestingModuleBuilder.compile()` calls
      // `Logger.overrideLogger(new TestingLogger())` unconditionally
      // (@nestjs/testing/testing-module.builder.js), so every *later*
      // `Test.createTestingModule(...).compile()` in this process — the
      // threshold block builds one — silently takes Nest's internal logging
      // back off pino. The visible symptom is narrow and nasty: request
      // logging still works, because that is pino-http middleware, but
      // `ExceptionsHandler` — the one component that logs a raw, unhandled
      // exception — goes somewhere this capture cannot see. Observed here as
      // a 500 whose error line was present when the block ran alone and
      // absent when the whole file ran.
      //
      // Production is unaffected: `main.ts` calls `useLogger` once and
      // nothing recompiles a module afterwards.
      app.useLogger(app.get(PinoNestLogger));
    });

    /**
     * Guards against the way this test fails uselessly: with nothing
     * captured, every "does not contain" assertion below passes vacuously.
     * It has already earned its place once — see `CapturingLoggingModule`.
     */
    async function assertCaptureIsLive(): Promise<string> {
      const text = await flushCapturedLogs();
      expect(text.length).toBeGreaterThan(0);
      // Proof that what was captured is this app's request logging and not
      // incidental output — the route pattern is logged deliberately, while
      // the resolved id is not.
      expect(text).toContain('/api/v1/observations');
      return text;
    }

    it('logs neither an accepted clinical value, nor a rejected one, nor a clinical timestamp', async () => {
      capturedLogLines.length = 0;

      // Values chosen to be unmistakable in a search and impossible to
      // collide with a status code, a port or a timestamp fragment.
      const acceptedValue = 1873.4321;
      const rejectedValue = -998877.5;
      const clinicalMoment = '2026-04-17T09:41:33.117Z';
      const token = patientA.token;

      await post(
        patientA,
        validPayload({
          valueQuantity: { value: acceptedValue, unit: 'mL' },
          effectiveDateTime: clinicalMoment,
        }),
      ).expect(201);

      await post(
        patientA,
        validPayload({ valueQuantity: { value: rejectedValue, unit: 'mL' } }),
      ).expect(422);

      // A date is HIPAA identifier #3, and on a GET it travels in the query
      // string — which `reqSerializer` strips by logging `req.path` rather
      // than `req.url`.
      await request(app.getHttpServer())
        .get('/api/v1/observations')
        .query({
          effectiveDateTimeFrom: '2026-04-17T00:00:00.000Z',
          effectiveDateTimeTo: '2026-04-17T23:59:59.999Z',
        })
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const text = await assertCaptureIsLive();

      expect(text).not.toContain('1873.4321');
      expect(text).not.toContain('998877');
      expect(text).not.toContain('2026-04-17');
      // The bearer token is a credential, and `reqSerializer` never assembles
      // request headers into a log line in the first place.
      expect(text).not.toContain(token);
      // No request body is ever assembled either, so there is no
      // `valueQuantity` key present to be redacted.
      expect(text).not.toContain('valueQuantity');
    });

    it('logs no client-supplied content when the transport-layer parser is what refused it', async () => {
      capturedLogLines.length = 0;

      // An unrecognized key whose *name* is itself client-supplied content,
      // carrying a value alongside it. zod's own message for this issue reads
      // `Unrecognized key: "..."`; nothing from a validator message reaches
      // either a response or a log line.
      await post(patientA, { ...validPayload(), patientNickname: 'Marjorie-4471' }).expect(400);

      const text = await assertCaptureIsLive();
      expect(text).not.toContain('Marjorie');
      expect(text).not.toContain('4471');
      expect(text).not.toContain('patientNickname');
    });

    it('refuses malformed JSON without echoing the raw body, in the response OR the log (H1)', async () => {
      capturedLogLines.length = 0;

      // A body corrupted in transit or double-encoded by a proxy. Before the
      // exception filter, `express.json()` threw before any pipe ran and
      // Nest's Express adapter mapped it to `BadRequestException(err.message)`
      // — V8's JSON.parse text, which quotes a window of the raw input around
      // the error position. For a payload this size that is the whole body,
      // so the patient's own volume came back in the 400 and into the
      // client's correction queue (§6.3).
      const response = await request(app.getHttpServer())
        .post('/api/v1/observations')
        .set('Authorization', `Bearer ${patientA.token}`)
        .set('Content-Type', 'application/json')
        .send('{"resourceType":"Observation","valueQuantity":{"value":4471.25q}}');

      expect(response.status).toBe(400);
      // The neutral, message-free protocol-error body — not an observation
      // rejection. A parse failure is request-level (§6.1), not a per-field
      // Tier 1 outcome, and dressing it up as one would invent a `field` no
      // validator identified.
      expect(response.body).toEqual({ error: { code: 'BAD_REQUEST' } });
      // Neither the volume nor any fragment of the raw body survives.
      expect(JSON.stringify(response.body)).not.toContain('4471');
      expect(JSON.stringify(response.body)).not.toContain('valueQuantity');
      expect(JSON.stringify(response.body)).not.toContain('JSON');

      // A parse failure never reaches a route, so it produces no
      // `/api/v1/observations` line for `assertCaptureIsLive()` to key on.
      // One ordinary request supplies that marker, proving the capture is
      // live before the "does not contain" assertion is trusted — the whole
      // point of that helper.
      await post(patientA, validPayload()).expect(201);

      const text = await assertCaptureIsLive();
      expect(text).not.toContain('4471');
    });

    it('refuses a bad percent-escape in the path with the same shape rather than a framework body', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/observations/%FF')
        .set('Authorization', `Bearer ${patientA.token}`);

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: { code: 'BAD_REQUEST' } });
    });

    it('leaves a real Tier 1 rejection untouched — the filter must not flatten the bodies this module authors', async () => {
      const response = await post(
        patientA,
        validPayload({ valueQuantity: { value: -1, unit: 'mL' } }),
      );

      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        error: {
          code: 'OBSERVATION_VALIDATION_BLOCKED',
          errors: [{ field: 'valueQuantity.value', reasonCode: 'VALUE_NOT_POSITIVE' }],
        },
      });
    });

    it('logs a 500 without the clinical value, when the database itself is what refused the insert', async () => {
      capturedLogLines.length = 0;

      // The P1.S5 B3 hazard, reproduced on the path that actually carries a
      // clinical value. Prisma renders the failing operation — and Postgres
      // renders the failing ROW, i.e. every column value including the
      // volume — into the error's own `.message`. `errSerializer` allow-lists
      // `message` through verbatim and the redaction lists match object
      // paths, so neither can reach a substring inside that string. The only
      // control that works is `ObservationPersistenceError` never letting the
      // original error travel, which is what this asserts.
      //
      // `NOT VALID` so the constraint applies to new inserts without being
      // checked against the rows already there.
      const owner = new PgClient({ connectionString: container.getConnectionUri() });
      await owner.connect();
      try {
        await owner.query(
          `ALTER TABLE observations ADD CONSTRAINT forced_failure_probe CHECK (false) NOT VALID`,
        );

        const body = validPayload({ valueQuantity: { value: 4242.4242, unit: 'mL' } });
        const response = await post(patientA, body);

        expect(response.status).toBe(500);
        // Nest's default 500 body, which carries no detail of its own.
        expect(JSON.stringify(response.body)).not.toContain('4242');

        const text = await assertCaptureIsLive();
        // The wrapper is what was logged...
        expect(text).toContain('ObservationPersistenceError');
        // ...and nothing of the clinical value or of the database error's own
        // message came with it.
        expect(text).not.toContain('4242');
        expect(text).not.toContain('forced_failure_probe');

        // Nothing partial was left behind: the audit row and the observation
        // row share one transaction, so a failed insert leaves neither.
        expect(await observationRows(body.id as string)).toHaveLength(0);
        expect(await auditRows(body.id as string)).toHaveLength(0);
      } finally {
        await owner.query(
          `ALTER TABLE observations DROP CONSTRAINT IF EXISTS forced_failure_probe`,
        );
        await owner.end();
      }
    });
  });

  describe('The generated typed client, exercised against the running API', () => {
    it('creates, reads back and lists through packages/core/src/api-client', async () => {
      const patient = await seedPatient('METRIC');
      const client = createApiClient({
        baseUrl,
        getAccessToken: () => patient.token,
      });

      const id = randomUUID();
      const created = await client.observations.create({
        resourceType: 'Observation',
        id,
        status: 'final',
        code: '79560-9',
        valueQuantity: { value: 275.25, unit: 'mL' },
        effectiveDateTime: '2026-09-07T14:00:00.000Z',
        method: null,
        enteredMeasurementSystem: 'metric',
        enteredTimezone: 'America/Chicago',
      });

      expect(created.observation.id).toBe(id);
      // `valueQuantity` is optional on the wire since P3.S2 (a colour-only
      // voided-urine entry carries none), so this asserts the object is
      // present as well as its value — on a stoma-output entry its absence
      // would itself be the defect.
      expect(created.observation.valueQuantity).toMatchObject({ value: 275.25 });
      expect(created.warnings).toEqual([]);

      const readBack = await client.observations.findOne(id);
      expect(readBack).toEqual(created.observation);

      const listed = await client.observations.list({ limit: 10 });
      expect(listed.observations.map((observation) => observation.id)).toContain(id);
    });

    it('throws a typed ApiError a client can route to its correction queue', async () => {
      const client = createApiClient({
        baseUrl,
        getAccessToken: () => patientA.token,
      });

      const error = await captureApiError(
        client.observations.create({
          resourceType: 'Observation',
          id: randomUUID(),
          status: 'final',
          code: '79560-9',
          valueQuantity: { value: -1, unit: 'mL' },
          effectiveDateTime: '2026-09-07T14:00:00.000Z',
          method: null,
          enteredMeasurementSystem: 'metric',
          enteredTimezone: 'America/Chicago',
        }),
      );

      expect(error.status).toBe(422);
      // Read deliberately, through the accessor named for the one legitimate
      // destination. The rejection is still fully available to a correction
      // queue — this is not a redaction.
      expect(error.rejectionForCorrectionQueue()).toMatchObject({
        error: {
          code: 'OBSERVATION_VALIDATION_BLOCKED',
          errors: [{ field: 'valueQuantity.value', reasonCode: 'VALUE_NOT_POSITIVE' }],
        },
      });
      // The message a crash reporter would capture carries no clinical value.
      expect(error.message).not.toContain('-1');

      // …and neither does the error itself under the serializations that
      // carry one off-device by default. `body` is non-enumerable, so
      // JSON.stringify, React Native's LogBox, util.inspect and Sentry's
      // ExtraErrorData all miss it. Before this, `JSON.stringify(error)`
      // emitted the whole rejection, reason codes included — and
      // EFFECTIVE_DATE_TIME_BEFORE_SURGERY discloses a surgery date (§6.3).
      expect(JSON.stringify(error)).not.toContain('VALUE_NOT_POSITIVE');
      expect(Object.keys(error)).not.toContain('body');
      expect(inspect(error)).not.toContain('VALUE_NOT_POSITIVE');
    });

    it('refuses to call an authenticated endpoint with no token rather than calling it anonymously', async () => {
      const client = createApiClient({ baseUrl });
      await expect(client.observations.list()).rejects.toThrow(/access token/i);
    });
  });
});
