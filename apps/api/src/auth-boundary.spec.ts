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
 * Proves the identity-layer boundary SRS_v2 §4.6 and ADR-0008 require: a
 * valid patient token must not be accepted by the admin guard, and a valid
 * admin token must not be accepted by the patient guard — even though both
 * guards use the same underlying `jose` verification mechanics, because
 * each is bound to its own separate issuer, audience, and JWKS.
 */
import { UnauthorizedException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';

import { AdminJwtAuthGuard } from './admin/admin-jwt-auth.guard';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import type { AppConfig } from './config/env.schema';
import {
  createHttpExecutionContext,
  requestWithAuthHeader,
} from './test-support/execution-context';
import { createTestOidcIssuer, type TestOidcIssuer } from './test-support/oidc-test-tokens';

const PATIENT_ISSUER = 'https://mock-oidc.test/patient-issuer';
const PATIENT_AUDIENCE = 'ostomy-patient-app';
const ADMIN_ISSUER = 'https://mock-oidc.test/admin-issuer';
const ADMIN_AUDIENCE = 'ostomy-admin-console';

function makeConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'silent',
    oidcClockToleranceSeconds: 30,
    syncPushMaxOperations: 500,
    syncDeltaDefaultLimit: 200,
    syncDeltaMaxLimit: 1000,
    databaseUrl: 'postgresql://ostomy_runtime:unused@localhost:5432/unused',
    oidc: {
      issuer: PATIENT_ISSUER,
      jwksUri: 'https://unused.test/jwks',
      audience: PATIENT_AUDIENCE,
      claimMapping: { subjectClaim: 'sub' },
    },
    adminOidc: {
      issuer: ADMIN_ISSUER,
      jwksUri: 'https://unused.test/admin-jwks',
      audience: ADMIN_AUDIENCE,
      claimMapping: { subjectClaim: 'sub' },
    },
    objectStorage: {
      endpoint: 'https://unused.test',
      region: 'us-east-1',
      accessKeyId: 'unused',
      secretAccessKey: 'unused',
      forcePathStyle: true,
    },
  };
}

describe('patient/admin identity boundary — SRS_v2 §4.6, ADR-0008', () => {
  let patientIssuer: TestOidcIssuer;
  let adminIssuer: TestOidcIssuer;

  beforeAll(async () => {
    patientIssuer = await createTestOidcIssuer();
    adminIssuer = await createTestOidcIssuer();
  });

  it('rejects a valid patient token at the admin guard', async () => {
    const config = makeConfig();
    const patientToken = await patientIssuer.sign({
      issuer: PATIENT_ISSUER,
      audience: PATIENT_AUDIENCE,
      subject: 'patient-123',
    });

    // Even a same-key coincidence would still fail on issuer/audience —
    // but here the admin guard is also given the patient issuer's JWKS,
    // which a correctly-configured deployment would never do. The point is
    // that the guard's own issuer/audience check is what rejects it.
    const adminGuard = new AdminJwtAuthGuard(config, patientIssuer.getKey);
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${patientToken}`));

    await expect(adminGuard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a valid admin token at the patient guard', async () => {
    const config = makeConfig();
    const adminToken = await adminIssuer.sign({
      issuer: ADMIN_ISSUER,
      audience: ADMIN_AUDIENCE,
      subject: 'admin-123',
    });

    const patientGuard = new JwtAuthGuard(config, adminIssuer.getKey);
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${adminToken}`));

    await expect(patientGuard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a patient token at the admin guard even when the admin guard is wired with its own (correct) JWKS', async () => {
    const config = makeConfig();
    const patientToken = await patientIssuer.sign({
      issuer: PATIENT_ISSUER,
      audience: PATIENT_AUDIENCE,
      subject: 'patient-123',
    });

    const adminGuard = new AdminJwtAuthGuard(config, adminIssuer.getKey);
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${patientToken}`));

    await expect(adminGuard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
