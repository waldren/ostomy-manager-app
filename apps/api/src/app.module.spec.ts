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

import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplicationContext } from '@nestjs/common';

import { AppModule } from './app.module';
import type { AppConfig } from './config/env.schema';

function testConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'silent',
    oidcClockToleranceSeconds: 30,
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
});
