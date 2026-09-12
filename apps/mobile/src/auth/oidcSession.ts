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

import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';

import type { OidcClientConfig } from './oidcConfig';

/**
 * Authorization Code + PKCE against a standard OIDC provider
 * (`expo-auth-session`), never a vendor SDK — this app speaks the same
 * discovery/authorize/token surface in development (mock-oauth2-server)
 * and production (the patient Cognito user pool's hosted UI), per
 * CLAUDE.md "never import a Cognito SDK".
 *
 * Required once per app, at module scope, so a completed authorization
 * redirect (Android intent / iOS universal link back into this app)
 * dismisses the in-app browser rather than leaving it open — the
 * documented `expo-auth-session` setup step.
 */
WebBrowser.maybeCompleteAuthSession();

export interface OidcTokens {
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  readonly idToken: string | undefined;
  /** Epoch seconds; `undefined` if the provider did not return `expires_in` (treated as "does not expire" per `expo-auth-session`'s own `TokenResponse.isTokenFresh` convention — never assumed to be zero). */
  readonly expiresAtSeconds: number | undefined;
}

function toOidcTokens(response: AuthSession.TokenResponse): OidcTokens {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    idToken: response.idToken,
    expiresAtSeconds:
      response.expiresIn === undefined ? undefined : response.issuedAt + response.expiresIn,
  };
}

/**
 * Builds the `AuthRequestConfig` this app's login screen passes to
 * `AuthSession.useAuthRequest`. A plain function, not a hook, so it can be
 * unit tested without rendering a component.
 */
export function buildAuthRequestConfig(
  config: OidcClientConfig,
  redirectUri: string,
): AuthSession.AuthRequestConfig {
  return {
    clientId: config.clientId,
    redirectUri,
    scopes: [...config.scopes],
    responseType: AuthSession.ResponseType.Code,
    // Default is true, but stated explicitly: PKCE is not optional for a
    // public (secret-less) mobile client (RFC 8252 §8.1), and this is the
    // one line that makes that a decision on record rather than an
    // accident of a library default.
    usePKCE: true,
  };
}

export interface AuthorizationCodeResult {
  readonly code: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
}

/** Narrows an `expo-auth-session` `AuthSessionResult` down to the one shape this app acts on: a completed, successful authorization. Every other outcome (`cancel`, `dismiss`, `error`, `locked`) is the login screen's job to render as "try again," not this module's to interpret. */
export function extractAuthorizationCode(
  request: AuthSession.AuthRequest,
  response: AuthSession.AuthSessionResult | null,
): AuthorizationCodeResult | undefined {
  if (response?.type !== 'success') return undefined;
  if (request.codeVerifier === undefined) return undefined;
  // `params` is `Record<string, string>`, and `noUncheckedIndexedAccess`
  // (packages/config's base tsconfig) makes that index read
  // `string | undefined` — a real provider always includes `code` on a
  // `type: 'success'` result, but the type does not promise it, so this is
  // checked rather than asserted.
  const code = response.params.code;
  if (code === undefined) return undefined;
  return {
    code,
    redirectUri: request.redirectUri,
    codeVerifier: request.codeVerifier,
  };
}

export async function exchangeAuthorizationCode(
  discovery: AuthSession.DiscoveryDocument,
  config: OidcClientConfig,
  authorization: AuthorizationCodeResult,
): Promise<OidcTokens> {
  const response = await AuthSession.exchangeCodeAsync(
    {
      clientId: config.clientId,
      code: authorization.code,
      redirectUri: authorization.redirectUri,
      extraParams: { code_verifier: authorization.codeVerifier },
    },
    discovery,
  );
  return toOidcTokens(response);
}

/**
 * Exchanges the stored refresh token for a fresh access token. Called
 * after a successful biometric unlock (`AuthContext.tsx`) — never before
 * one, and never itself gating whether the app is usable: see
 * `AuthContext.tsx`'s header comment on why a network failure here does
 * not block local (offline) app access.
 */
export async function refreshAccessToken(
  discovery: AuthSession.DiscoveryDocument,
  config: OidcClientConfig,
  refreshToken: string,
): Promise<OidcTokens> {
  const response = await AuthSession.refreshAsync(
    { clientId: config.clientId, refreshToken },
    discovery,
  );
  return toOidcTokens(response);
}

export { useAuthRequest, useAutoDiscovery } from 'expo-auth-session';
