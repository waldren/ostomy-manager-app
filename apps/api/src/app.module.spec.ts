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

import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplicationContext, Type } from '@nestjs/common';

import { AppModule } from './app.module';
import { AuditStubController } from './audit/test-support/audit-stub.controller';
import type { AppConfig } from './config/env.schema';

function testConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'silent',
    oidcClockToleranceSeconds: 30,
    // Deliberately unreachable — `PrismaModule` is part of AppModule's graph
    // as of P1.S5 (see app.module.ts's comment), but `PrismaService` still
    // connects lazily on first query (see that class's own comment) and
    // `app.init()` never queries it: the boot-time privilege self-check
    // (`assertRuntimeRoleIsNotOverPrivileged()`) is called explicitly from
    // `main.ts`'s bootstrap, not from any Nest lifecycle hook this test
    // exercises. So this test still never needs a live Postgres, only a
    // syntactically valid DSN to satisfy AppConfig's type.
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

describe('AppModule wiring', () => {
  let app: INestApplicationContext | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('compiles the full module graph given a valid config', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(testConfig())],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    expect(app).toBeDefined();
  });

  /**
   * B4 (P1.S5 review response): `AuditStubModule` — TEST SCAFFOLDING with
   * no application-level cleanup path for what it persists (see
   * `app.module.ts`'s own comment) — must never ship in a `production`
   * config graph. Asserted two ways: no discovered controller path
   * contains `audit-stub`, and the controller itself is not resolvable
   * from the compiled module. A single assertion checking only one of
   * these could pass while the other fails (e.g. the controller is
   * present in the graph but happens to 404 for an unrelated reason), so
   * both are checked directly rather than inferring one from the other.
   */
  it('excludes AuditStubModule, and every audit-stub route, from a production-config graph', async () => {
    const config = testConfig();
    config.nodeEnv = 'production';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule.register(config), DiscoveryModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    const discovery = app.get(DiscoveryService);
    const controllerPaths = discovery
      .getControllers()
      .map((wrapper) => wrapper.metatype as Type<unknown> | undefined)
      .filter((metatype): metatype is Type<unknown> => metatype !== undefined)
      .map((metatype) => Reflect.getMetadata(PATH_METADATA, metatype) as unknown)
      .filter((path): path is string => typeof path === 'string');

    expect(controllerPaths.some((path) => path.includes('audit-stub'))).toBe(false);
    expect(() => app!.get(AuditStubController, { strict: true })).toThrow();
  });
});
