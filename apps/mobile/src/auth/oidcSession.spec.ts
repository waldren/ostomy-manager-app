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
import { buildAuthRequestConfig, extractAuthorizationCode } from './oidcSession';

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
    expect(extractAuthorizationCode(request, { type: 'cancel' } as AuthSessionResult)).toBeUndefined();
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
