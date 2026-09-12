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

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  exchangeAuthorizationCode,
  refreshAccessToken,
  TokenExchangeError,
} from './token-client.js';

describe('token-client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('exchanges an authorization code with the PKCE verifier, never the secret-based flow', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'a', token_type: 'Bearer', expires_in: 3600 }), {
        status: 200,
      }),
    );

    const result = await exchangeAuthorizationCode({
      tokenEndpoint: 'https://issuer.example/token',
      clientId: 'ostomy-web',
      code: 'the-code',
      redirectUri: 'https://app.example/callback',
      codeVerifier: 'the-verifier',
    });

    expect(result.access_token).toBe('a');
    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = new URLSearchParams(init?.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBe('the-verifier');
    expect(body.get('client_secret')).toBeNull();
  });

  it('throws TokenExchangeError on a non-2xx response, without leaking the response body', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(new Response('invalid_grant', { status: 400 }));

    await expect(
      exchangeAuthorizationCode({
        tokenEndpoint: 'https://issuer.example/token',
        clientId: 'ostomy-web',
        code: 'bad-code',
        redirectUri: 'https://app.example/callback',
        codeVerifier: 'v',
      }),
    ).rejects.toBeInstanceOf(TokenExchangeError);
  });

  it('refreshes using the refresh_token grant', async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'b', token_type: 'Bearer', expires_in: 3600 }), {
        status: 200,
      }),
    );

    await refreshAccessToken({
      tokenEndpoint: 'https://issuer.example/token',
      clientId: 'ostomy-web',
      refreshToken: 'the-refresh-token',
    });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    const body = new URLSearchParams(init?.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('the-refresh-token');
  });
});
