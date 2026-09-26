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

jest.mock('expo-web-browser', () => ({
  maybeCompleteAuthSession: jest.fn(),
  dismissAuthSession: jest.fn(),
}));

import type { AuthRequest, AuthSessionResult } from 'expo-auth-session';

import type { OidcClientConfig } from './oidcConfig';
import {
  ACCESS_TOKEN_RENEWAL_MARGIN_SECONDS,
  accessTokenNeedsRenewal,
  buildAuthRequestConfig,
  extractAuthorizationCode,
  isRefreshTokenRejected,
} from './oidcSession';

const CONFIG: OidcClientConfig = {
  issuer: 'http://localhost:8090/patient-issuer',
  clientId: 'ostomy-patient-app',
  audience: 'ostomy-patient-app',
  scopes: ['openid', 'profile', 'offline_access'],
};

describe('buildAuthRequestConfig', () => {
  it('requests an authorization code with PKCE, never the implicit flow', () => {
    const config = buildAuthRequestConfig(CONFIG, 'ostomydiary://redirect');
    expect(config).toMatchObject({
      clientId: 'ostomy-patient-app',
      redirectUri: 'ostomydiary://redirect',
      scopes: ['openid', 'profile', 'offline_access'],
      responseType: 'code',
      usePKCE: true,
    });
  });
});

/** Builds a well-formed `type: 'success'` `AuthSessionResult` with only `params` varying — the fields this app never reads (`errorCode`, `authentication`, `url`) are filled with the library's own "nothing here" values rather than cast away. */
function successResult(params: Record<string, string>): AuthSessionResult {
  return { type: 'success', errorCode: null, authentication: null, url: '', params };
}

describe('extractAuthorizationCode', () => {
  const request = {
    codeVerifier: 'a-code-verifier',
    redirectUri: 'ostomydiary://redirect',
  } as AuthRequest;

  it('returns undefined for a non-success result (cancel, dismiss, error)', () => {
    expect(
      extractAuthorizationCode(request, { type: 'cancel' } as AuthSessionResult),
    ).toBeUndefined();
    expect(extractAuthorizationCode(request, null)).toBeUndefined();
  });

  it('extracts the code, redirectUri, and codeVerifier on success', () => {
    const response = successResult({ code: 'auth-code-123' });

    expect(extractAuthorizationCode(request, response)).toEqual({
      code: 'auth-code-123',
      redirectUri: 'ostomydiary://redirect',
      codeVerifier: 'a-code-verifier',
    });
  });

  it('returns undefined if PKCE was somehow not used (no codeVerifier)', () => {
    const requestWithoutVerifier = { redirectUri: 'ostomydiary://redirect' } as AuthRequest;
    const response = successResult({ code: 'auth-code-123' });

    expect(extractAuthorizationCode(requestWithoutVerifier, response)).toBeUndefined();
  });
});

/**
 * #40. Both a dead refresh token and an unreachable provider arrive as a thrown
 * error from `refreshAccessToken`, and treating them alike is what left the app
 * reporting an authenticated session while holding no access token.
 */
describe('isRefreshTokenRejected', () => {
  /** What `expo-auth-session`'s `TokenError` actually looks like: `code` is the raw OAuth error, `params` the response. */
  function tokenError(error: string): Error & { code: string; params: Record<string, string> } {
    return Object.assign(new Error(error), { code: error, params: { error } });
  }

  it('is true for invalid_grant, the one terminal case', async () => {
    expect(isRefreshTokenRejected(tokenError('invalid_grant'))).toBe(true);
  });

  it('reads params.error when code is absent', async () => {
    // `code` is the documented accessor and `params` is the source it comes from;
    // a provider or library version that populates only one must still be understood.
    expect(isRefreshTokenRejected({ params: { error: 'invalid_grant' } })).toBe(true);
  });

  it('is false for a network failure, which means unknown fate', async () => {
    // The session must survive this. The app is used offline by design, and signing a
    // patient out of a diary they can still write in is the worse of the two errors.
    expect(isRefreshTokenRejected(new TypeError('Network request failed'))).toBe(false);
  });

  it('is false for a transient server error', async () => {
    expect(isRefreshTokenRejected(tokenError('temporarily_unavailable'))).toBe(false);
  });

  /**
   * Excluded on purpose, though they look terminal: both describe a client
   * registration or deployment fault, so a re-login fails identically. Signing the
   * patient out would cost them offline access and fix nothing.
   */
  it('is false for client-configuration errors', async () => {
    expect(isRefreshTokenRejected(tokenError('invalid_client'))).toBe(false);
    expect(isRefreshTokenRejected(tokenError('unauthorized_client'))).toBe(false);
  });

  it('is false for anything that is not an error object', async () => {
    expect(isRefreshTokenRejected(undefined)).toBe(false);
    expect(isRefreshTokenRejected(null)).toBe(false);
    expect(isRefreshTokenRejected('invalid_grant')).toBe(false);
  });
});

/**
 * `expiresAtSeconds` was captured and never consulted, so an access token simply
 * lapsed mid-session: every request 401'd, the sync worker stopped with
 * `unauthenticated` (which schedules no retry), and nothing recovered until the next
 * lock and unlock. An access token lives for minutes and a session lives for days,
 * so this is the ordinary case rather than an edge.
 */
describe('accessTokenNeedsRenewal', () => {
  const now = 1_700_000_000_000; // ms
  const nowSeconds = now / 1000;

  it('is false for a token with plenty of life left', async () => {
    expect(accessTokenNeedsRenewal(nowSeconds + 3600, now)).toBe(false);
  });

  it('is true for a token that has already expired', async () => {
    expect(accessTokenNeedsRenewal(nowSeconds - 1, now)).toBe(true);
  });

  /**
   * The margin is not decoration. A request leaving with a token that expires in
   * 200ms arrives after it has lapsed, and this compares the issuer's expiry against
   * the DEVICE clock, which ADR-0019 exists because it cannot be trusted.
   */
  it('is true inside the renewal margin, before expiry', async () => {
    expect(accessTokenNeedsRenewal(nowSeconds + ACCESS_TOKEN_RENEWAL_MARGIN_SECONDS - 1, now)).toBe(
      true,
    );
    expect(accessTokenNeedsRenewal(nowSeconds + ACCESS_TOKEN_RENEWAL_MARGIN_SECONDS + 1, now)).toBe(
      false,
    );
  });

  /**
   * `undefined` is "the provider returned no `expires_in`", which
   * `expo-auth-session`'s own `isTokenFresh` treats as never-expiring. Reading it as
   * expired would refresh before every single request against such an issuer.
   */
  it('is false when the provider gave no expiry', async () => {
    expect(accessTokenNeedsRenewal(undefined, now)).toBe(false);
  });
});
