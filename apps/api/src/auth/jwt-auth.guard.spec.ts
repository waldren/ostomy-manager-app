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
import { AUTH_ERROR_CODE, JwtAuthGuard } from './jwt-auth.guard';

const ISSUER = 'https://mock-oidc.test/patient-issuer';
const AUDIENCE = 'ostomy-patient-app';

function makeConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'silent',
    oidc: {
      issuer: ISSUER,
      jwksUri: 'https://unused.test/jwks',
      audience: AUDIENCE,
      claimMapping: { subjectClaim: 'sub' },
    },
    adminOidc: {
      issuer: 'https://mock-oidc.test/admin-issuer',
      jwksUri: 'https://unused.test/admin-jwks',
      audience: 'ostomy-admin-console',
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

describe('JwtAuthGuard — patient OIDC authentication', () => {
  let issuer: TestOidcIssuer;

  beforeAll(async () => {
    issuer = await createTestOidcIssuer();
  });

  function makeGuard(): JwtAuthGuard {
    return new JwtAuthGuard(makeConfig(), issuer.getKey);
  }

  it('rejects a request with no token', async () => {
    const guard = makeGuard();
    const context = createHttpExecutionContext(requestWithAuthHeader(undefined));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: AUTH_ERROR_CODE.MISSING_TOKEN },
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
      subject: 'patient-123',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token with the wrong audience — the case config wiring most easily gets silently wrong', async () => {
    const guard = makeGuard();
    const token = await issuer.sign({
      issuer: ISSUER,
      audience: 'some-other-app',
      subject: 'patient-123',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: AUTH_ERROR_CODE.INVALID_AUDIENCE },
    });
  });

  it('rejects a token with the wrong issuer', async () => {
    const guard = makeGuard();
    const token = await issuer.sign({
      issuer: 'https://not-the-configured-issuer.test',
      audience: AUDIENCE,
      subject: 'patient-123',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: AUTH_ERROR_CODE.INVALID_ISSUER },
    });
  });

  it('rejects an expired token', async () => {
    const guard = makeGuard();
    const token = await issuer.sign({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'patient-123',
      expiresIn: '-1s',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: AUTH_ERROR_CODE.TOKEN_EXPIRED },
    });
  });

  it('accepts a validly signed token with the correct issuer and audience, and attaches the patient id', async () => {
    const guard = makeGuard();
    const token = await issuer.sign({ issuer: ISSUER, audience: AUDIENCE, subject: 'patient-123' });
    const request = requestWithAuthHeader(`Bearer ${token}`) as unknown as {
      patient?: { id: string };
    };
    const context = createHttpExecutionContext(request);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.patient?.id).toBe('patient-123');
  });

  it('rejects a token missing the configured subject claim', async () => {
    const guard = makeGuard();
    const token = await issuer.sign({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'patient-123',
      subjectClaim: 'not-sub',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: AUTH_ERROR_CODE.MISSING_SUBJECT_CLAIM },
    });
  });
});
