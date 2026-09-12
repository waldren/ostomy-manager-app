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
 * Architectural test: enforces that every route in the module graph is
 * either explicitly public or guarded — structurally, not by convention.
 *
 * There is deliberately no global (`APP_GUARD`) guard in this app (see
 * `README.md`): a single global guard would need to special-case the admin
 * surface, which puts the patient/admin boundary back into ordinary
 * authorization logic and undoes what ADR-0008 buys by keeping the two
 * guards structurally separate. Instead, this test boots the real module
 * graph, discovers every registered controller and route handler through
 * Nest's own metadata (the same metadata `@UseGuards` writes), and asserts
 * the convention holds — so a forgotten `@UseGuards()` decorator fails a
 * test instead of shipping as an unauthenticated PHI endpoint (this is
 * exactly the P2.S1a failure mode this test exists to catch before it
 * happens: a controller reachable with no guard, with lint, typecheck and
 * tests all otherwise green).
 *
 * P1.S5 adds a fourth assertion: every mutating route (POST/PUT/PATCH/DELETE/ALL)
 * must carry `@Audited()` (`audit/audited.decorator.ts`). The audit
 * interceptor is the one enhancer in this app that *is* registered globally
 * (`APP_INTERCEPTOR`, via `audit/audit-interceptor.module.ts`), because
 * per-controller opt-in is exactly how a sync-applied write ends up
 * unaudited — see README.md's note on scoping "no global enhancer" to
 * guards specifically. Being registered globally makes the interceptor
 * *capable* of auditing every route; this assertion is what makes every
 * mutating route actually *require* it — a POST/PUT/PATCH/DELETE/ALL handler
 * with no `@Audited()` fails this test the same way an unguarded route
 * does above, rather than shipping as a silently-unaudited PHI write.
 */
import { RequestMethod, type Type } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { INestApplicationContext } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';

import { AdminJwtAuthGuard } from './admin/admin-jwt-auth.guard';
import { AppModule } from './app.module';
import { AUDITED_KEY } from './audit/audited.decorator';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import type { AppConfig } from './config/env.schema';

function testConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'silent',
    oidcClockToleranceSeconds: 30,
    syncPushMaxOperations: 500,
    syncDeltaDefaultLimit: 200,
    syncDeltaMaxLimit: 1000,
    // Deliberately unreachable — see app.module.spec.ts's identical field
    // for why this still never needs a live Postgres despite PrismaModule
    // being part of AppModule's graph as of P1.S5.
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

/**
 * Routes allowed to carry no guard at all. Adding an entry here is a
 * security decision, not a convenience — each one should be rare and say
 * why. `GET /api/v1/health` is a liveness probe with no dependency on
 * anything requiring authentication (see `health.controller.ts`).
 */
const PUBLIC_ROUTES: ReadonlySet<string> = new Set(['GET /api/v1/health']);

interface DiscoveredRoute {
  key: string;
  httpMethod: RequestMethod;
  guards: unknown[];
  audited: boolean;
}

/**
 * POST/PUT/PATCH/DELETE/ALL — the HTTP methods a PHI mutation can arrive
 * on. `GET` and `HEAD` never mutate, so they carry no audit obligation.
 *
 * `RequestMethod.ALL` (S4, P1.S5 review response) is included: an `@All()`
 * handler accepts every method, POST included, so a mutating `@All()`
 * handler is exactly as capable of writing PHI as an explicit `@Post()`
 * one. Omitting it here let an `@All()` handler skip the `@Audited()`
 * requirement entirely, regardless of what it actually did.
 */
const MUTATING_HTTP_METHODS: ReadonlySet<RequestMethod> = new Set([
  RequestMethod.POST,
  RequestMethod.PUT,
  RequestMethod.PATCH,
  RequestMethod.DELETE,
  RequestMethod.ALL,
]);

function pathSegment(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function normalizePath(...segments: string[]): string {
  const joined = segments
    .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
    .filter((segment) => segment.length > 0)
    .join('/');
  return `/${joined}`;
}

function requestMethodToString(method: RequestMethod): string {
  return RequestMethod[method] ?? `UNKNOWN(${String(method)})`;
}

function discoverRoutes(discovery: DiscoveryService): DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];

  for (const wrapper of discovery.getControllers()) {
    const metatype = wrapper.metatype as Type<unknown> | undefined;
    if (!metatype) continue;

    const controllerPath = pathSegment(Reflect.getMetadata(PATH_METADATA, metatype));
    const classGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, metatype) ?? [];

    const prototype = metatype.prototype as Record<string, unknown>;
    for (const propertyName of Object.getOwnPropertyNames(prototype)) {
      if (propertyName === 'constructor') continue;
      const handler = prototype[propertyName];
      if (typeof handler !== 'function') continue;

      const httpMethod: RequestMethod | undefined = Reflect.getMetadata(METHOD_METADATA, handler);
      if (httpMethod === undefined) continue; // not a route handler

      const handlerPath = pathSegment(Reflect.getMetadata(PATH_METADATA, handler));
      const methodGuards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];
      // Mirrors `AuditInterceptor`'s own `reflector.getAllAndOverride(AUDITED_KEY,
      // [handler, class])` (S4, P1.S5 review response): handler-level metadata
      // wins when present, falling back to class-level `@Audited()`. The
      // previous `Reflect.getMetadata(AUDITED_KEY, handler) === true` read
      // only the handler and only the literal boolean `true` — so a
      // class-level `@Audited()` satisfied the runtime interceptor (which
      // does check the class) but failed this build-time check, and
      // `@Audited({ allowEmpty: true })` (S2's object-shaped metadata) would
      // have failed the strict `=== true` comparison even on a handler that
      // carried it directly.
      const audited = Boolean(
        Reflect.getMetadata(AUDITED_KEY, handler) ?? Reflect.getMetadata(AUDITED_KEY, metatype),
      );

      const fullPath = normalizePath('api/v1', controllerPath, handlerPath);
      routes.push({
        key: `${requestMethodToString(httpMethod)} ${fullPath}`,
        httpMethod,
        guards: [...classGuards, ...methodGuards],
        audited,
      });
    }
  }

  return routes;
}

describe('route guard coverage — every route is guarded or explicitly public', () => {
  let app: INestApplicationContext | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('boots the real module graph and enforces the guard convention on every discovered route', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(testConfig()), DiscoveryModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const discovery = app.get(DiscoveryService);
    const routes = discoverRoutes(discovery);

    // Sanity check on the discovery mechanism itself: if this is ever zero,
    // the test below would vacuously pass having checked nothing.
    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      const hasPatientGuard = route.guards.includes(JwtAuthGuard);
      const hasAdminGuard = route.guards.includes(AdminJwtAuthGuard);
      const isAdminSurface = /^[A-Z]+ \/api\/v1\/admin\//.test(route.key);

      if (PUBLIC_ROUTES.has(route.key)) {
        expect(
          hasPatientGuard,
          `${route.key} is on PUBLIC_ROUTES but also carries JwtAuthGuard — remove it from the allowlist or the guard`,
        ).toBe(false);
        expect(
          hasAdminGuard,
          `${route.key} is on PUBLIC_ROUTES but also carries AdminJwtAuthGuard — remove it from the allowlist or the guard`,
        ).toBe(false);
        continue;
      }

      if (isAdminSurface) {
        expect(
          hasAdminGuard,
          `${route.key} is under admin/ but has no AdminJwtAuthGuard — every admin route must carry it`,
        ).toBe(true);
        expect(
          hasPatientGuard,
          `${route.key} is under admin/ but also carries JwtAuthGuard — the admin surface must never share a guard with the patient surface (ADR-0008)`,
        ).toBe(false);
      } else {
        expect(
          hasPatientGuard,
          `${route.key} is not on PUBLIC_ROUTES and not under admin/, but has no JwtAuthGuard — did you forget @UseGuards(JwtAuthGuard), or does this route belong on PUBLIC_ROUTES?`,
        ).toBe(true);
        expect(
          hasAdminGuard,
          `${route.key} is not under admin/ but carries AdminJwtAuthGuard — patient routes must never carry the admin guard`,
        ).toBe(false);
      }

      // P1.S5: every mutating route must be @Audited(), or a PHI write can
      // ship with lint, typecheck, and every other test green while landing
      // no row in audit_events at all.
      if (MUTATING_HTTP_METHODS.has(route.httpMethod)) {
        expect(
          route.audited,
          `${route.key} is a mutating (${requestMethodToString(route.httpMethod)}) route with no @Audited() — ` +
            'did you forget it, or does this route genuinely never write PHI (in which case, does it need to mutate at all)?',
        ).toBe(true);
      }
    }
  });
});
