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

/**
 * Why the redirect's own query string is the authoritative source of the
 * code, and `promptAsync()` is not (ADR-0021).
 *
 * On Android the authorization server's redirect to `ostomydiary://redirect`
 * is resolved by `MainActivity` — the only component declaring that scheme's
 * BROWSABLE filter — and `launchMode="singleTask"` brings its existing task
 * to the front (`START_TASK_TO_FRONT`), tearing down the Custom Tab.
 * `expo-web-browser`'s `BrowserProxyActivity`, which is what resolves
 * `promptAsync()`, is never the target, so that promise does not report the
 * success it is waiting for. Sign-in could not complete at all (#72).
 *
 * The code was never lost: it arrives in the deep link, which Expo Router
 * hands to `app/redirect.tsx` as ordinary route params. So the completer reads
 * it from there, which works whichever component the platform happens to
 * resolve the redirect to — and needs no change to the native manifest,
 * whose `singleTask` mode is load-bearing for every other deep link.
 */
export type AuthorizationCallbackOutcome =
  | { readonly kind: 'authorization'; readonly authorization: AuthorizationCodeResult }
  /** The provider reported a failure in the redirect itself (RFC 6749 §4.1.2.1). */
  | { readonly kind: 'provider-error' }
  /** No request was in flight, or its `state` does not match. */
  | { readonly kind: 'unexpected' }
  /** Nothing actionable in the URL — the route was reached some other way. */
  | { readonly kind: 'not-a-callback' };

/**
 * Reads an authorization code out of the redirect's parameters, checking it
 * against the request that was actually issued.
 *
 * Plain and synchronous so it can be tested without a device: the persistence
 * and the token call are the caller's, and this is the part that decides
 * whether a given URL is a callback this app asked for.
 *
 * **`state` is verified here and the result is refused if it disagrees.** A
 * completer driven by a URL is reachable by anything that can open a link with
 * this app's scheme, so without that check it would exchange a code an
 * attacker chose — the CSRF that `state` exists for (RFC 6749 §10.12). A
 * mismatch is `unexpected`, never silently retried.
 */
export function readAuthorizationCallback(
  params: Readonly<Record<string, string | string[] | undefined>>,
  pending:
    | { readonly codeVerifier: string; readonly state: string; readonly redirectUri: string }
    | undefined,
): AuthorizationCallbackOutcome {
  // Expo Router types a repeated query parameter as an array. A provider does
  // not send one, so the array form is treated as absent rather than having
  // its first element picked: guessing which of two values to trust is how a
  // parameter-pollution bug starts.
  const single = (value: string | string[] | undefined): string | undefined =>
    typeof value === 'string' ? value : undefined;

  const error = single(params.error);
  const code = single(params.code);
  const state = single(params.state);

  if (error !== undefined) return { kind: 'provider-error' };
  if (code === undefined) return { kind: 'not-a-callback' };
  // From here the URL claims to be a callback, so every remaining failure is
  // reported rather than ignored — a code this app cannot safely exchange is a
  // sign-in that failed, and the patient has to be told.
  if (pending === undefined) return { kind: 'unexpected' };
  if (state === undefined || state !== pending.state) return { kind: 'unexpected' };

  return {
    kind: 'authorization',
    authorization: {
      code,
      redirectUri: pending.redirectUri,
      codeVerifier: pending.codeVerifier,
    },
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

/**
 * Whether a failed refresh means the refresh token itself is dead, as opposed to
 * the provider being unreachable (#40).
 *
 * The distinction is the whole issue. Both arrive as a thrown error from
 * `refreshAccessToken`, and treating them alike is why an expired session left the
 * app reporting `authenticated` while holding no access token: nothing synced, no
 * screen said anything, and there was no route to a sign-in.
 *
 * RFC 6749 §5.2's `invalid_grant` is the terminal one — "the provided authorization
 * grant ... or refresh token is invalid, expired, revoked, does not match the
 * redirection URI ... or was issued to another client". No amount of retrying fixes
 * any of those; only a full OIDC login does.
 *
 * Everything else is deliberately NOT terminal, and the list is short on purpose. A
 * network failure, a timeout, a 5xx, `temporarily_unavailable`, an undecodable body:
 * all mean *unknown fate*, and the session must survive them, because this app is
 * used offline by design and signing a patient out of a diary they can still write
 * in would be the worse error. That is the same discipline `docs/sync-contract.md`
 * §9.3 imposes on the sync worker for the same reason.
 *
 * `invalid_client` and `unauthorized_client` are excluded too, though they look
 * terminal: they describe a client registration or deployment fault, so a re-login
 * would fail in exactly the same way. Signing the patient out would cost them their
 * offline access and fix nothing.
 *
 * **One false-positive class to know about before adding a background refresh.** An
 * issuer that ROTATES refresh tokens and invalidates the superseded one answers
 * `invalid_grant` to a duplicate refresh — so two concurrent refreshes would sign a
 * patient out of a perfectly good session. No concurrent path exists today: the
 * refresh happens only in `unlock()`, the button is inert while busy, and the sync
 * worker never refreshes. Cognito does not rotate. Adding a proactive or background
 * refresh creates the path, and this rule would then need a single-flight guard.
 *
 * `expo-auth-session` throws `TokenError`, whose `code` is the raw OAuth error
 * string (it reaches `CodedError` as `super(error, ...)`) and whose `params` holds
 * the response verbatim. Both are read, because `code` is the documented accessor
 * and `params.error` is the source it comes from.
 */
export function isRefreshTokenRejected(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, params } = error as { code?: unknown; params?: unknown };
  if (code === 'invalid_grant') return true;
  if (typeof params !== 'object' || params === null) return false;
  return (params as { error?: unknown }).error === 'invalid_grant';
}

export { useAuthRequest, useAutoDiscovery } from 'expo-auth-session';

/**
 * Revokes the refresh token at the issuer (RFC 7009).
 *
 * Without this, "sign out" only deleted the local copy: the token stayed
 * valid at the issuer until natural expiry, and the in-app browser's
 * session cookie survived — so the next person to press "Sign in" on a
 * shared or handed-down phone could be silently re-authenticated as the
 * previous patient, with no credential prompt.
 *
 * Best-effort by design. This runs during sign-out, and sign-out must
 * complete even offline — which is the normal case for this app. A failure
 * here leaves a token that expires on its own schedule; a failure that
 * blocked sign-out would leave the patient signed in on a device they are
 * trying to hand over, which is strictly worse.
 *
 * Not every issuer advertises a revocation endpoint; when none is present
 * there is nothing to call and nothing to report.
 */
export async function revokeRefreshToken(
  discovery: AuthSession.DiscoveryDocument,
  config: OidcClientConfig,
  refreshToken: string,
): Promise<void> {
  if (!discovery.revocationEndpoint) {
    return;
  }
  try {
    await AuthSession.revokeAsync({ token: refreshToken, clientId: config.clientId }, discovery);
  } catch {
    // Swallowed deliberately; see above. Nothing may be logged here in any
    // case — the only values in scope are a bearer credential and a client
    // id (CLAUDE.md, "never log PHI"; this app has no crash-reporting sink).
  }
}
