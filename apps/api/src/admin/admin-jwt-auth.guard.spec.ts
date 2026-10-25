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
import { ADMIN_AUTH_ERROR_CODE, AdminJwtAuthGuard } from './admin-jwt-auth.guard';

// MIRRORING OBLIGATION: this file deliberately mirrors every case in
// `../auth/jwt-auth.guard.spec.ts`, one-for-one, against this guard.
// `AdminJwtAuthGuard` and `JwtAuthGuard` intentionally share no
// implementation code (see the guard files' own comments and ADR-0008), so
// these two test files are the only thing keeping the two guards' behaviour
// in agreement. Adding a case to the patient spec without adding its mirror
// here is a regression, even though nothing will fail to compile — deleting
// this file's `issuer:` check once left all other tests green.

const ISSUER = 'https://mock-oidc.test/admin-issuer';
const AUDIENCE = 'ostomy-admin-console';

function makeConfig(): AppConfig {
  return {
    nodeEnv: 'test',
    port: 3000,
    logLevel: 'silent',
    oidcClockToleranceSeconds: 30,
    // No browser origin: these tests drive the API directly, not through one.
    corsAllowedOrigins: [],
    syncPushMaxOperations: 500,
    syncDeltaDefaultLimit: 200,
    syncDeltaMaxLimit: 1000,
    databaseUrl: 'postgresql://ostomy_runtime:unused@localhost:5432/unused',
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

  function makeGuard(config: AppConfig = makeConfig()): AdminJwtAuthGuard {
    return new AdminJwtAuthGuard(config, issuer.getKey);
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

  it('rejects a token with the wrong issuer', async () => {
    const guard = makeGuard();
    const token = await issuer.sign({
      issuer: 'https://not-the-configured-issuer.test',
      audience: AUDIENCE,
      subject: 'admin-123',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: ADMIN_AUTH_ERROR_CODE.INVALID_ISSUER },
    });
  });

  it('rejects an expired token', async () => {
    const guard = makeGuard();
    const token = await issuer.sign({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'admin-123',
      expiresIn: '-1h',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: ADMIN_AUTH_ERROR_CODE.TOKEN_EXPIRED },
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

  it('rejects a token missing the configured subject claim', async () => {
    const guard = makeGuard();
    const token = await issuer.sign({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'admin-123',
      subjectClaim: 'not-sub',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: ADMIN_AUTH_ERROR_CODE.MISSING_SUBJECT_CLAIM },
    });
  });

  // --- B1: mirrors the patient guard's test ---------------------------------

  it('rejects a token with no expiration claim at all — jose only checks exp "if defined", so an unbounded token needs its own rejection', async () => {
    const guard = makeGuard();
    const token = await issuer.signWithoutExpiration({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'admin-123',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  // --- B3: mirrors the patient guard's test ---------------------------------

  it('attaches only { id }, never the verified claims payload', async () => {
    const guard = makeGuard();
    const token = await issuer.sign({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'admin-123',
    });
    const request = requestWithAuthHeader(`Bearer ${token}`) as unknown as {
      admin?: Record<string, unknown>;
    };
    const context = createHttpExecutionContext(request);

    await guard.canActivate(context);

    expect(request.admin).toEqual({ id: 'admin-123' });
    expect(request.admin).not.toHaveProperty('claims');
  });

  // --- S3: mirrors the patient guard's algorithm-confusion tests ------------

  it('rejects an unsecured ("alg": "none") token', async () => {
    const guard = makeGuard();
    const token = signWithNoneAlgorithm({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'admin-123',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: ADMIN_AUTH_ERROR_CODE.INVALID_ALGORITHM },
    });
  });

  it('rejects an HS256 token signed with the RS256 public key bytes as the "secret" (algorithm confusion)', async () => {
    const guard = makeGuard();
    const token = await signWithHs256UsingPublicKeyAsSecret(
      { issuer: ISSUER, audience: AUDIENCE, subject: 'admin-123' },
      issuer.publicJwk,
    );
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: ADMIN_AUTH_ERROR_CODE.INVALID_ALGORITHM },
    });
  });

  // --- S8: mirrors the patient guard's clock-tolerance tests ----------------

  it('accepts a token expired by less than the configured clock tolerance', async () => {
    const guard = makeGuard(makeConfig());
    const token = await issuer.sign({
      issuer: ISSUER,
      audience: AUDIENCE,
      subject: 'admin-123',
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
      subject: 'admin-123',
      expiresIn: '-1h',
    });
    const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      response: { code: ADMIN_AUTH_ERROR_CODE.TOKEN_EXPIRED },
    });
  });

  /**
   * P4.S6 (#168): tokens shaped exactly like Cognito's. Its ACCESS token names
   * the app client in `client_id` and carries no `aud`; its ID token carries
   * `aud` = the client id, `token_use: "id"`, and the user's email and phone
   * number. Against the default settings the access token is refused and the
   * ID token accepted, which is the wrong way round, and why these settings
   * exist.
   */
  describe('a provider that names the client in client_id, as Cognito does', () => {
    const SUBJECT = 'admin-123';

    function cognitoConfig(
      overrides: Partial<AppConfig['adminOidc']['claimMapping']> = {},
    ): AppConfig {
      const config = makeConfig();
      config.adminOidc.claimMapping = {
        subjectClaim: 'sub',
        audienceClaim: 'client_id',
        requiredTokenUse: 'access',
        ...overrides,
      };
      return config;
    }

    function accessToken(overrides: Record<string, unknown> = {}): Promise<string> {
      return issuer.signPayload(ISSUER, {
        sub: SUBJECT,
        client_id: AUDIENCE,
        token_use: 'access',
        scope: 'openid',
        auth_time: Math.floor(Date.now() / 1000),
        username: SUBJECT,
        ...overrides,
      });
    }

    function idToken(): Promise<string> {
      return issuer.signPayload(ISSUER, {
        sub: SUBJECT,
        aud: AUDIENCE,
        token_use: 'id',
        email: 'synthetic@example.test',
        phone_number: '+15555550100',
      });
    }

    async function refusal(config: AppConfig, token: string): Promise<unknown> {
      const guard = makeGuard(config);
      const context = createHttpExecutionContext(requestWithAuthHeader(`Bearer ${token}`));
      return guard.canActivate(context).then(
        () => 'accepted',
        (error: { response?: { code?: string } }) => error.response?.code,
      );
    }

    it('accepts an access token, and keeps only its subject', async () => {
      const guard = makeGuard(cognitoConfig());
      const request = requestWithAuthHeader(`Bearer ${await accessToken()}`) as unknown as {
        admin?: unknown;
      };

      await expect(guard.canActivate(createHttpExecutionContext(request))).resolves.toBe(true);
      expect(request.admin).toEqual({ id: SUBJECT });
    });

    it('refuses an ID token: no client_id, and the wrong token_use', async () => {
      expect(await refusal(cognitoConfig(), await idToken())).toBe(
        ADMIN_AUTH_ERROR_CODE.INVALID_AUDIENCE,
      );
      // Even read through `aud`, where the ID token's client check passes.
      expect(await refusal(cognitoConfig({ audienceClaim: 'aud' }), await idToken())).toBe(
        ADMIN_AUTH_ERROR_CODE.INVALID_TOKEN_USE,
      );
    });

    it('refuses an access token for another app client', async () => {
      expect(
        await refusal(cognitoConfig(), await accessToken({ client_id: 'another-client' })),
      ).toBe(ADMIN_AUTH_ERROR_CODE.INVALID_AUDIENCE);
    });

    it.each([
      ['missing', undefined],
      ['an array holding the client', [AUDIENCE]],
      ['a number', 42],
    ])('refuses a client_id that is %s', async (_name, clientId) => {
      expect(await refusal(cognitoConfig(), await accessToken({ client_id: clientId }))).toBe(
        ADMIN_AUTH_ERROR_CODE.INVALID_AUDIENCE,
      );
    });

    it('refuses an access token with no token_use, or another one', async () => {
      expect(await refusal(cognitoConfig(), await accessToken({ token_use: undefined }))).toBe(
        ADMIN_AUTH_ERROR_CODE.INVALID_TOKEN_USE,
      );
      expect(await refusal(cognitoConfig(), await accessToken({ token_use: 'id' }))).toBe(
        ADMIN_AUTH_ERROR_CODE.INVALID_TOKEN_USE,
      );
    });

    it('still checks the issuer and the signature', async () => {
      const unrelatedKey = await createTestOidcIssuer();
      const unsigned = await unrelatedKey.signPayload(ISSUER, {
        sub: SUBJECT,
        client_id: AUDIENCE,
        token_use: 'access',
      });
      expect(await refusal(cognitoConfig(), unsigned)).toBe(
        ADMIN_AUTH_ERROR_CODE.INVALID_SIGNATURE,
      );

      const otherIssuer = await issuer.signPayload('https://another-pool.test', {
        sub: SUBJECT,
        client_id: AUDIENCE,
        token_use: 'access',
      });
      expect(await refusal(cognitoConfig(), otherIssuer)).toBe(
        ADMIN_AUTH_ERROR_CODE.INVALID_ISSUER,
      );
    });

    it('refuses a token that names the client only in aud, once client_id is the setting', async () => {
      const token = await issuer.sign({ issuer: ISSUER, audience: AUDIENCE, subject: SUBJECT });
      expect(await refusal(cognitoConfig({ requiredTokenUse: undefined }), token)).toBe(
        ADMIN_AUTH_ERROR_CODE.INVALID_AUDIENCE,
      );
    });

    it('accepts an access token that names the client in aud when a token_use is required', async () => {
      const token = await issuer.signPayload(ISSUER, {
        sub: SUBJECT,
        aud: AUDIENCE,
        token_use: 'access',
      });
      expect(await refusal(cognitoConfig({ audienceClaim: 'aud' }), token)).toBe('accepted');
    });

    it('reads the token kind from the configured claim, and only from it', async () => {
      const config = cognitoConfig({ tokenUseClaim: 'kind' });
      expect(
        await refusal(config, await accessToken({ token_use: undefined, kind: 'access' })),
      ).toBe('accepted');
      expect(await refusal(config, await accessToken({ kind: 'id' }))).toBe(
        ADMIN_AUTH_ERROR_CODE.INVALID_TOKEN_USE,
      );
      expect(await refusal(config, await accessToken({ token_use: 'id', kind: 'access' }))).toBe(
        'accepted',
      );
    });

    // #169 review: the defaults must not be the settings that accept an ID
    // token, so a token that DECLARES a kind other than access is refused
    // with nothing configured. One that declares none is still accepted.
    it('with the default settings, refuses an ID token, which declares itself one', async () => {
      expect(await refusal(makeConfig(), await idToken())).toBe(
        ADMIN_AUTH_ERROR_CODE.INVALID_TOKEN_USE,
      );
      const undeclared = await issuer.signPayload(ISSUER, { sub: SUBJECT, aud: AUDIENCE });
      expect(await refusal(makeConfig(), undeclared)).toBe('accepted');
    });

    it('with the default settings, refuses the access token (what the spike predicted)', async () => {
      expect(await refusal(makeConfig(), await accessToken())).toBe(
        ADMIN_AUTH_ERROR_CODE.INVALID_AUDIENCE,
      );
    });
  });
});
