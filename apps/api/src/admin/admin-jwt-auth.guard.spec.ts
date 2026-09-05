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

import { UnauthorizedException } from '@nestjs/common';
import { beforeAll, describe, expect, it } from 'vitest';

import type { AppConfig } from '../config/env.schema';
import {
  createHttpExecutionContext,
  requestWithAuthHeader,
} from '../test-support/execution-context';
import {
  createTestOidcIssuer,
  signWithUnrelatedKey,
  type TestOidcIssuer,
} from '../test-support/oidc-test-tokens';
import { ADMIN_AUTH_ERROR_CODE, AdminJwtAuthGuard } from './admin-jwt-auth.guard';

const ISSUER = 'https://mock-oidc.test/admin-issuer';
const AUDIENCE = 'ostomy-admin-console';

function makeConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'silent',
    oidc: {
      issuer: 'https://mock-oidc.test/patient-issuer',
      jwksUri: 'https://unused.test/jwks',
      audience: 'ostomy-patient-app',
      claimMapping: { subjectClaim: 'sub' },
    },
    adminOidc: {
      issuer: ISSUER,
      jwksUri: 'https://unused.test/admin-jwks',
      audience: AUDIENCE,
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

describe('AdminJwtAuthGuard — admin OIDC authentication', () => {
  let issuer: TestOidcIssuer;

  beforeAll(async () => {
    issuer = await createTestOidcIssuer();
  });

  function makeGuard(): AdminJwtAuthGuard {
    return new AdminJwtAuthGuard(makeConfig(), issuer.getKey);
  }

  it('rejects a request with no token', async () => {
    const guard = makeGuard();
    const context = createHttpExecutionContext(requestWithAuthHeader(undefined));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: ADMIN_AUTH_ERROR_CODE.MISSING_TOKEN },
    });
  });

  it('rejects a malformed token', async () => {
    const guard = makeGuard();
    const context = createHttpExecutionContext(requestWithAuthHeader('Bearer not-a-jwt'));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token signed by a key not in the JWKS', async () => {
    const guard = makeGuard();
    const token = await signWithUnrelatedKey({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'admin-123',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token with the wrong audience', async () => {
    const guard = makeGuard();
    const token = await issuer.sign({
      issuer: ISSUER,
      audience: 'some-other-console',
      subject: 'admin-123',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: ADMIN_AUTH_ERROR_CODE.INVALID_AUDIENCE },
    });
  });

  it('accepts a validly signed token with the correct issuer and audience, and attaches the admin id', async () => {
    const guard = makeGuard();
    const token = await issuer.sign({ issuer: ISSUER, audience: AUDIENCE, subject: 'admin-123' });
    const request = requestWithAuthHeader(`Bearer ${token}`) as unknown as {
      admin?: { id: string };
    };
    const context = createHttpExecutionContext(request);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.admin?.id).toBe('admin-123');
  });
});
