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
  signWithHs256UsingPublicKeyAsSecret,
  signWithNoneAlgorithm,
  signWithUnrelatedKey,
  type TestOidcIssuer,
} from '../test-support/oidc-test-tokens';
import { AUTH_ERROR_CODE, JwtAuthGuard } from './jwt-auth.guard';

// MIRRORING OBLIGATION: `admin-jwt-auth.guard.spec.ts` deliberately mirrors
// every case in this file (issuer/audience/expiry/subject/algorithm/exp
// requirement), one-for-one, against the admin guard. `JwtAuthGuard` and
// `AdminJwtAuthGuard` intentionally share no implementation code (see the
// guard files' own comments and ADR-0008), so these two test files are the
// only thing keeping the two guards' behaviour in agreement. Adding a case
// below without adding its mirror in the admin spec is a regression, even
// though nothing will fail to compile.

const ISSUER = 'https://mock-oidc.test/patient-issuer';
const AUDIENCE = 'ostomy-patient-app';

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

  function makeGuard(config: AppConfig = makeConfig()): JwtAuthGuard {
    return new JwtAuthGuard(config, issuer.getKey);
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
      expiresIn: '-1h',
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

  // --- B1: a token with no `exp` must not verify forever -------------------

  it('rejects a token with no expiration claim at all — jose only checks exp "if defined", so an unbounded token needs its own rejection', async () => {
    const guard = makeGuard();
    const token = await issuer.signWithoutExpiration({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'patient-123',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // --- B3: only the subject id is attached to the request, never the full
  // claims payload (Cognito tokens routinely carry email, phone_number,
  // birthdate, name — four of the eighteen HIPAA identifiers). ------------

  it('attaches only { id }, never the verified claims payload', async () => {
    const guard = makeGuard();
    const token = await issuer.sign({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'patient-123',
    });
    const request = requestWithAuthHeader(`Bearer ${token}`) as unknown as {
      patient?: Record<string, unknown>;
    };
    const context = createHttpExecutionContext(request);

    await guard.canActivate(context);

    expect(request.patient).toEqual({ id: 'patient-123' });
    expect(request.patient).not.toHaveProperty('claims');
  });

  // --- S3: algorithm confusion. Both cases are correctly rejected today
  // because `algorithms: ['RS256']` is passed to jwtVerify — nothing here
  // would fail if that option were ever dropped in a refactor, which is
  // exactly why this needs its own test rather than relying on the
  // wrong-signature test above to catch it incidentally. ------------------

  it('rejects an unsecured ("alg": "none") token', async () => {
    const guard = makeGuard();
    const token = signWithNoneAlgorithm({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'patient-123',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: AUTH_ERROR_CODE.INVALID_ALGORITHM },
    });
  });

  it('rejects an HS256 token signed with the RS256 public key bytes as the "secret" (algorithm confusion)', async () => {
    const guard = makeGuard();
    const token = await signWithHs256UsingPublicKeyAsSecret(
      { issuer: ISSUER, audience: AUDIENCE, subject: 'patient-123' },
      issuer.publicJwk,
    );
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: AUTH_ERROR_CODE.INVALID_ALGORITHM },
    });
  });

  // --- S8: clock tolerance is wired from config, not left at jose's
  // zero-tolerance default. ------------------------------------------------

  it('accepts a token expired by less than the configured clock tolerance', async () => {
    const guard = makeGuard(makeConfig());
    const token = await issuer.sign({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'patient-123',
      expiresIn: '-10s',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('rejects a token expired by more than the configured clock tolerance', async () => {
    const config = makeConfig();
    config.oidcClockToleranceSeconds = 5;
    const guard = makeGuard(config);
    const token = await issuer.sign({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'patient-123',
      expiresIn: '-1h',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: AUTH_ERROR_CODE.TOKEN_EXPIRED },
    });
  });
});
