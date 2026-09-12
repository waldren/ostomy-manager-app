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

/** The standard OAuth 2.0 token-endpoint response shape (RFC 6749 §5.1). */
export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: string;
  readonly expires_in: number;
  readonly refresh_token?: string;
  /**
   * Present whenever `openid` is among the requested scopes. Kept only to
   * pass back as `id_token_hint` at RP-initiated logout — never decoded and
   * never used for authorization (see `StoredTokens.idToken`).
   */
  readonly id_token?: string;
}

export class TokenExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenExchangeError';
  }
}

async function postToTokenEndpoint(
  tokenEndpoint: string,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });

  if (!response.ok) {
    throw new TokenExchangeError(`Token endpoint responded with status ${response.status}`);
  }

  return (await response.json()) as TokenResponse;
}

export function exchangeAuthorizationCode(params: {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  /** The API's resource identifier — see `OidcConfig.audience`. */
  readonly audience: string;
}): Promise<TokenResponse> {
  return postToTokenEndpoint(params.tokenEndpoint, {
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
    audience: params.audience,
  });
}

export function refreshAccessToken(params: {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly refreshToken: string;
  /**
   * Sent on refresh as well as on the initial exchange. An issuer that scopes
   * tokens by audience will otherwise mint a refreshed token with the default
   * audience, so the session would work until the first refresh and then 401
   * — a failure that looks like a session bug rather than a config one.
   */
  readonly audience: string;
}): Promise<TokenResponse> {
  return postToTokenEndpoint(params.tokenEndpoint, {
    grant_type: 'refresh_token',
    client_id: params.clientId,
    refresh_token: params.refreshToken,
    audience: params.audience,
  });
}
