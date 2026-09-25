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

/**
 * The in-flight authorization request, persisted across the browser round
 * trip (ADR-0021).
 *
 * `app/redirect.tsx` completes the authorization code exchange, and it runs
 * in a component that did not create the request — it may not even be the
 * same process, since Android is free to reclaim the app while the browser
 * is foregrounded. So the two values the exchange cannot be done without
 * have to outlive the screen that started it:
 *
 * - the **PKCE code verifier**, without which the token endpoint refuses the
 *   code (RFC 7636);
 * - the **`state`** the request was issued with, without which the completer
 *   would accept a code from anywhere. A completer that cannot check `state`
 *   is not an authorization code flow, it is a URL handler.
 *
 * ## Why SecureStore, and why WITHOUT `requireAuthentication`
 *
 * The verifier is a secret for the lifetime of one sign-in, so it belongs in
 * the keystore rather than in plain storage — but **not** behind ADR-0015's
 * biometric gate, which `tokenStorage.ts` applies to the refresh token.
 *
 * ADR-0015 gates a stored session belonging to an already-enrolled patient.
 * This value is read in the middle of establishing that session, when there
 * is no session and no identity to authenticate against. Demanding
 * biometrics at that moment would gate the sign-in on the thing sign-in
 * exists to create — a deadlock, not a safeguard. ADR-0021 records that
 * narrowing.
 *
 * The exposure that narrowing accepts is small and bounded: an attacker who
 * can already read this device's keystore learns a single-use verifier for an
 * in-flight request, which is worthless without the matching authorization
 * code arriving at this same app's redirect URI. It is deleted the moment the
 * exchange resolves, either way.
 *
 * ## Why not the encrypted SQLite store
 *
 * ADR-0014 binds that store to one OIDC subject and destroys it when a
 * different subject signs in. At this point in the flow the subject is
 * precisely what has not been established yet, so it is the wrong container
 * by construction.
 */

import * as SecureStore from 'expo-secure-store';

const PENDING_REQUEST_KEY = 'ostomy.oidc.pending_request';

/**
 * Deliberately NOT `REFRESH_TOKEN_OPTIONS`.
 *
 * `keychainAccessible` matches it — this never needs reading before first
 * unlock, and never needs to leave the device — but `requireAuthentication`
 * is omitted, which means `false`. See the module comment: a biometric prompt
 * here would gate sign-in on an enrolment that sign-in is what establishes.
 */
const PENDING_REQUEST_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export interface PendingAuthRequest {
  /** RFC 7636's code verifier, required by the token endpoint. */
  readonly codeVerifier: string;
  /** The `state` the authorization request carried, checked on return. */
  readonly state: string;
  /**
   * The exact `redirect_uri` the authorization request used.
   *
   * The token endpoint requires it to match byte for byte, and re-deriving it
   * in the completer would be a second implementation of
   * `makeRedirectUri(REDIRECT_URI_OPTIONS)` that could drift from the first.
   */
  readonly redirectUri: string;
}

/** Records the request that is now in flight, replacing any earlier one. */
export async function setPendingAuthRequest(request: PendingAuthRequest): Promise<void> {
  await SecureStore.setItemAsync(
    PENDING_REQUEST_KEY,
    JSON.stringify(request),
    PENDING_REQUEST_OPTIONS,
  );
}

/**
 * The request in flight, or `undefined` when there is none or the stored
 * value cannot be trusted.
 *
 * A value that does not parse, or that parses to something missing a field,
 * is treated as absent rather than thrown: the only honest response to an
 * unreadable pending request is "there is no usable request in flight", and
 * the caller's failure path already handles that. Throwing here would turn a
 * corrupt keystore entry into an unhandled rejection inside a route render.
 */
export async function getPendingAuthRequest(): Promise<PendingAuthRequest | undefined> {
  const raw = await SecureStore.getItemAsync(PENDING_REQUEST_KEY, PENDING_REQUEST_OPTIONS);
  if (raw === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const { codeVerifier, state, redirectUri } = parsed as Partial<PendingAuthRequest>;
    if (
      typeof codeVerifier !== 'string' ||
      typeof state !== 'string' ||
      typeof redirectUri !== 'string'
    ) {
      return undefined;
    }
    return { codeVerifier, state, redirectUri };
  } catch {
    return undefined;
  }
}

/**
 * Forgets the in-flight request.
 *
 * Called on **every** terminal outcome — a completed exchange, a failed one,
 * and a browser the patient dismissed. A verifier left behind is a secret
 * kept for no reason, and worse, a later redirect carrying a stale `state`
 * would be checked against a request nobody is waiting on.
 */
export async function clearPendingAuthRequest(): Promise<void> {
  await SecureStore.deleteItemAsync(PENDING_REQUEST_KEY, PENDING_REQUEST_OPTIONS);
}
