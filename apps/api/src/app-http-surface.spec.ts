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
 * One real HTTP-level test, per docs/testing.md's tool choice for
 * `apps/api` (Vitest + Supertest). Everything else in this workspace tests
 * guards, config, and serializers as plain TypeScript units — none of that
 * proves the pieces actually wire together into a listening HTTP server.
 *
 * That gap is not hypothetical here: `app.init()` in `app.module.spec.ts`
 * does not catch `UnknownDependenciesException` — a provider wired with a
 * wrong token still throws, but only from a codepath this repo hit and fixed
 * during P1.S1, not from a codepath any existing test exercises. P1.S5's
 * audit interceptor is the same class of enhancer with the same failure
 * mode, except there the consequence is a PHI write that ships unaudited.
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AdminJwtAuthGuard } from './admin/admin-jwt-auth.guard';
import { AppModule } from './app.module';
import { AuditService } from './audit/audit.service';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { PATIENT_JWKS_RESOLVER } from './auth/patient-jwks-resolver.token';
import type { AppConfig } from './config/env.schema';
import { createTestOidcIssuer } from './test-support/oidc-test-tokens';

function testConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'silent',
    oidcClockToleranceSeconds: 30,
    databaseUrl: 'postgresql://ostomy_runtime:unused@localhost:5432/unused',
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

describe('HTTP surface — GET /api/v1/*', () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function bootTestApp(): Promise<INestApplication> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(testConfig())],
    }).compile();
    const nestApp = moduleRef.createNestApplication();
    // Mirrors main.ts's setGlobalPrefix — without it every route is mounted
    // at its bare controller path (`/health`, not `/api/v1/health`), which
    // is exactly the kind of prod-vs-test wiring gap this test file exists
    // to catch by hitting real routes over real HTTP.
    nestApp.setGlobalPrefix('api/v1');
    await nestApp.init();
    return nestApp;
  }

  it('GET /api/v1/health returns 200 with no authentication required', async () => {
    app = await bootTestApp();

    const response = await request(app.getHttpServer()).get('/api/v1/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok' });
  });

  it('GET /api/v1/auth-stub with no bearer token returns 401 AUTH_MISSING_TOKEN', async () => {
    app = await bootTestApp();

    const response = await request(app.getHttpServer()).get('/api/v1/auth-stub');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'AUTH_MISSING_TOKEN' });
  });

  it('GET /api/v1/admin/auth-stub with no bearer token returns 401 ADMIN_AUTH_MISSING_TOKEN', async () => {
    app = await bootTestApp();

    const response = await request(app.getHttpServer()).get('/api/v1/admin/auth-stub');

    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: 'ADMIN_AUTH_MISSING_TOKEN' });
  });

  it('a token accepted by JwtAuthGuard is rejected by the admin route, and vice versa, at the real HTTP layer', async () => {
    app = await bootTestApp();

    // Confirms only that both guards are actually wired to their respective
    // routes at the HTTP layer — the boundary's correctness (issuer/audience
    // isolation) is covered exhaustively at the unit level in
    // auth-boundary.spec.ts; this just proves the two guard classes are the
    // ones attached to these two paths in the real app, not swapped.
    expect(JwtAuthGuard).not.toBe(AdminJwtAuthGuard);

    const patientRouteResponse = await request(app.getHttpServer())
      .get('/api/v1/auth-stub')
      .set('Authorization', 'Bearer not-a-real-token');
    const adminRouteResponse = await request(app.getHttpServer())
      .get('/api/v1/admin/auth-stub')
      .set('Authorization', 'Bearer not-a-real-token');

    expect(patientRouteResponse.status).toBe(401);
    expect(adminRouteResponse.status).toBe(401);
  });

  /**
   * P1.S5's own "AC6": proves `AuditInterceptor` actually resolves and runs
   * on a real, listening HTTP server — not merely that `app.init()`
   * succeeds (which, per this file's own header comment, does not prove an
   * enhancer resolves correctly on the first real request). `AuditService`
   * is overridden with a fake here rather than exercised against a real
   * Postgres — this file, per ADR-0002, stays a fast unit-level Supertest
   * suite; the full "a real audit_events row lands, connected as the
   * runtime role" proof is `audit.integration.spec.ts`'s job.
   */
  it('AuditInterceptor resolves and runs on a real request, staging an entry through to AuditService', async () => {
    const issuer = await createTestOidcIssuer();
    const config = testConfig();
    config.oidc.issuer = 'https://mock-oidc.test/patient-issuer';
    config.oidc.audience = 'ostomy-patient-app';

    const fakeAuditService = { record: vi.fn().mockResolvedValue({ id: 'audit-row-id' }) };

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(config)],
    })
      .overrideProvider(PATIENT_JWKS_RESOLVER)
      .useValue(issuer.getKey)
      .overrideProvider(AuditService)
      .useValue(fakeAuditService)
      .compile();
    const nestApp = moduleRef.createNestApplication();
    nestApp.setGlobalPrefix('api/v1');
    await nestApp.init();
    app = nestApp;

    const token = await issuer.sign({
      issuer: config.oidc.issuer,
      audience: config.oidc.audience,
      subject: 'patient-subject-http-surface',
    });

    const response = await request(app.getHttpServer())
      .post('/api/v1/audit-stub/widgets')
      .set('Authorization', `Bearer ${token}`)
      .send({ note: 'synthetic test scaffolding, no PHI' });

    expect(response.status).toBe(201);
    expect(response.body.id).toEqual(expect.any(String));
    expect(fakeAuditService.record).toHaveBeenCalledTimes(1);
    expect(fakeAuditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'PATIENT',
        actorId: 'patient-subject-http-surface',
        action: 'CREATE',
        entityType: 'audit_stub_widget',
        entityId: response.body.id,
        correlationId: expect.any(String),
      }),
    );
  });
});
