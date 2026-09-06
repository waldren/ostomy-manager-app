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
 * P1.S5's central integration proof, run against real PostgreSQL
 * (Testcontainers, ADR-0002) and connected as the RUNTIME role, never the
 * owner (ADR-0011's own instruction for this exact test: "A test connecting
 * as the owner would pass regardless and would reproduce the exact defect
 * this ADR fixes"). Three things this file proves with real output:
 *
 *   AC1 — a PHI write with no corresponding `audit_events` row FAILS this
 *   suite. Two Nest module graphs are built from the same
 *   `AuditStubController`: one that also imports `AuditInterceptorModule`
 *   (the global interceptor is registered) and one that imports only
 *   `AuditModule` (the interceptor is never registered at all — "removing
 *   the interceptor", exactly as the sprint's exit criterion describes).
 *   The audited variant's write produces exactly one row; the unaudited
 *   variant's identical write succeeds at the HTTP layer with ZERO rows —
 *   this is the gap the interceptor exists to close, demonstrated by
 *   actually removing it, not asserted about it.
 *
 *   AC2 — `UPDATE`/`DELETE` on `audit_events` are refused by PostgreSQL for
 *   the runtime role, even immediately after the interceptor has itself
 *   written rows in this same test run (P1.S3 proved the grant in
 *   isolation; this re-proves it holds while the interceptor is the thing
 *   doing the writing).
 *
 *   AC3 — a sync-applied write and a last-write-wins conflict loser
 *   (ADR-0001) each produce an audit row carrying the actor and a shared
 *   correlation id, with NEITHER call going through an HTTP request of its
 *   own — `AuditService.record()`, the same function `AuditInterceptor`
 *   calls, is what a future P2.S1b conflict handler calls directly. This
 *   simulates that call shape; P2 owns the real sync endpoint.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PatientAuthModule } from '../auth/patient-auth.module';
import { PATIENT_JWKS_RESOLVER } from '../auth/patient-jwks-resolver.token';
import { ConfigModule } from '../config/config.module';
import type { AppConfig } from '../config/env.schema';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { createTestOidcIssuer, type TestOidcIssuer } from '../test-support/oidc-test-tokens';
import { AuditInterceptorModule } from './audit-interceptor.module';
import { AuditModule } from './audit.module';
import { AuditService } from './audit.service';
import { AuditStubModule } from './test-support/audit-stub.module';

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
  // Same discipline as prisma.integration.spec.ts (S10): a missing Docker
  // daemon must never be a silent green skip in CI.
  if (process.env.CI) {
    throw new Error(
      '[audit.integration.spec.ts] Docker is not reachable, but CI is set — refusing to silently ' +
        "skip P1.S5's central audit-coverage proof.",
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    '[audit.integration.spec.ts] Docker is not reachable — skipping. Run with a Docker daemon ' +
      'available (e.g. `pnpm --filter @ostomy/api test:integration`) to exercise this suite.',
  );
}

const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'audit-integration-test-only-password';

describe.skipIf(!dockerAvailable)(
  'P1.S5 audit coverage — real PostgreSQL, connected as the runtime role (ADR-0011)',
  () => {
    let container: StartedPostgreSqlContainer;
    let runtimeDatabaseUrl: string;
    let runtimeClient: PgClient;
    let issuer: TestOidcIssuer;
    let apps: INestApplication[];

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17-alpine')
        .withDatabase('ostomy_audit_test')
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
      } finally {
        await owner.end();
      }

      const host = container.getHost();
      const port = container.getPort();
      const database = container.getDatabase();
      runtimeDatabaseUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@${host}:${port}/${database}`;

      runtimeClient = new PgClient({ connectionString: runtimeDatabaseUrl });
      await runtimeClient.connect();

      issuer = await createTestOidcIssuer();
      apps = [];
    }, 90_000);

    afterAll(async () => {
      for (const app of apps) {
        await app.close();
      }
      await runtimeClient?.end();
      await container?.stop();
    });

    function testConfig(): AppConfig {
      return {
        nodeEnv: 'test',
        port: 3000,
        logLevel: 'silent',
        oidcClockToleranceSeconds: 30,
        databaseUrl: runtimeDatabaseUrl,
        oidc: {
          issuer: 'https://mock-oidc.test/patient-issuer',
          jwksUri: 'https://mock-oidc.test/patient-issuer/jwks',
          audience: 'ostomy-patient-app',
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
     * Builds the audit-stub app either WITH the global interceptor
     * (`withInterceptor: true`) or WITHOUT it — the exact "remove the
     * interceptor" AC1 asks for, achieved by simply not importing
     * `AuditInterceptorModule`, not by a test-only feature flag on
     * production code.
     */
    async function buildApp(withInterceptor: boolean): Promise<INestApplication> {
      const config = testConfig();
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.register(config),
          PatientAuthModule,
          PrismaModule,
          AuditModule,
          ...(withInterceptor ? [AuditInterceptorModule] : []),
          AuditStubModule,
        ],
      })
        .overrideProvider(PATIENT_JWKS_RESOLVER)
        .useValue(issuer.getKey)
        .compile();

      const app = moduleRef.createNestApplication();
      app.setGlobalPrefix('api/v1');
      await app.init();
      apps.push(app);
      return app;
    }

    async function signToken(subject: string): Promise<string> {
      return issuer.sign({
        issuer: 'https://mock-oidc.test/patient-issuer',
        audience: 'ostomy-patient-app',
        subject,
      });
    }

    async function createWidgetViaHttp(
      app: INestApplication,
      subject: string,
    ): Promise<{ status: number; id: string | undefined }> {
      const token = await signToken(subject);
      const response = await request(app.getHttpServer())
        .post('/api/v1/audit-stub/widgets')
        .set('Authorization', `Bearer ${token}`)
        .send({ note: 'synthetic test scaffolding, no PHI' });
      return { status: response.status, id: response.body?.id };
    }

    async function auditRowsFor(entityId: string): Promise<Array<Record<string, unknown>>> {
      const result = await runtimeClient.query(
        `SELECT actor_type, actor_id, action, entity_type, entity_id, reason_code, before_value, after_value
         FROM audit_events WHERE entity_id = $1`,
        [entityId],
      );
      return result.rows;
    }

    describe('AC1 — a PHI write with no corresponding audit_events row fails this suite', () => {
      it('the audited variant of the write produces exactly one audit_events row, carrying the actor', async () => {
        const app = await buildApp(true);
        const subject = `patient-audited-${randomUUID()}`;

        const { status, id } = await createWidgetViaHttp(app, subject);
        expect(status).toBe(201);
        expect(id).toEqual(expect.any(String));

        const rows = await auditRowsFor(id!);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          actor_type: 'PATIENT',
          actor_id: subject,
          action: 'CREATE',
          entity_type: 'audit_stub_widget',
          entity_id: id,
          reason_code: 'direct_write',
        });
      });

      it('THE SAME write, with AuditInterceptorModule removed from the graph, succeeds at HTTP but produces ZERO audit rows — this is what "removing the interceptor" means, demonstrated rather than asserted', async () => {
        const app = await buildApp(false);
        const subject = `patient-unaudited-${randomUUID()}`;

        const { status, id } = await createWidgetViaHttp(app, subject);
        // The write itself is unaffected — a controller with no interceptor
        // still runs its own logic. The gap is entirely in audit_events.
        expect(status).toBe(201);
        expect(id).toEqual(expect.any(String));

        const rows = await auditRowsFor(id!);
        expect(rows).toHaveLength(0);
      });
    });

    describe('AC2 — audit_events stays append-only for the runtime role while the interceptor is actively writing', () => {
      it('refuses UPDATE and DELETE immediately after the interceptor itself has written rows in this run', async () => {
        const app = await buildApp(true);
        const subject = `patient-append-only-check-${randomUUID()}`;
        const { id } = await createWidgetViaHttp(app, subject);
        expect((await auditRowsFor(id!)).length).toBeGreaterThan(0);

        await expect(
          runtimeClient.query(
            `UPDATE audit_events SET reason_code = 'tampered' WHERE entity_id = $1`,
            [id],
          ),
        ).rejects.toMatchObject({ message: expect.stringContaining('permission denied') });

        await expect(
          runtimeClient.query(`DELETE FROM audit_events WHERE entity_id = $1`, [id]),
        ).rejects.toMatchObject({ message: expect.stringContaining('permission denied') });
      });
    });

    describe('AC3 — a sync-applied write and a conflict loser each produce an audit row via AuditContext, with no HTTP request of their own', () => {
      it('carries the actor and a shared correlation id on both rows, distinguished by reasonCode', async () => {
        const prismaService = new PrismaService({ databaseUrl: runtimeDatabaseUrl } as AppConfig);
        const auditService = new AuditService(prismaService);
        try {
          const pushCorrelationId = `sync-push-${randomUUID()}`;
          const entityId = randomUUID();
          const actorId = `patient-sync-${randomUUID()}`;

          // The winning write P2.S1b's push handler would apply — no HTTP
          // request object exists at this call site; AuditContext alone
          // carries what the interceptor would otherwise have read off one.
          await auditService.record({
            actorType: 'PATIENT',
            actorId,
            action: 'UPDATE',
            entityType: 'observation',
            entityId,
            reasonCode: 'sync_applied',
            beforeValue: { valueQuantityValue: 100 },
            afterValue: { valueQuantityValue: 150 },
            correlationId: pushCorrelationId,
          });

          // The losing side of the same last-write-wins resolution
          // (ADR-0001): a distinct entity in general, but sharing the same
          // push's correlation id — that is the reconstruction ADR-0001
          // requires ("thread it through so an auditor can reconstruct
          // which resolution belonged to which push").
          const loserEntityId = randomUUID();
          await auditService.record({
            actorType: 'PATIENT',
            actorId,
            action: 'UPDATE',
            entityType: 'observation',
            entityId: loserEntityId,
            reasonCode: 'sync_conflict_loser',
            beforeValue: { valueQuantityValue: 150 },
            afterValue: { valueQuantityValue: 140 },
            correlationId: pushCorrelationId,
          });

          const appliedRows = await auditRowsFor(entityId);
          const loserRows = await auditRowsFor(loserEntityId);
          expect(appliedRows).toHaveLength(1);
          expect(loserRows).toHaveLength(1);

          expect(appliedRows[0]).toMatchObject({ actor_id: actorId, reason_code: 'sync_applied' });
          expect(loserRows[0]).toMatchObject({
            actor_id: actorId,
            reason_code: 'sync_conflict_loser',
          });

          // Both rows' afterValue nests the same push's correlation id
          // (AuditService.record()'s documented placement — see that
          // method's own doc comment for why there is no dedicated column).
          const appliedAfter = appliedRows[0]!.after_value as { correlationId?: string };
          const loserAfter = loserRows[0]!.after_value as { correlationId?: string };
          expect(appliedAfter.correlationId).toBe(pushCorrelationId);
          expect(loserAfter.correlationId).toBe(pushCorrelationId);
        } finally {
          await prismaService.$disconnect();
        }
      });
    });
  },
);
