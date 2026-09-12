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
 * `sessionStorage`-backed storage for the OAuth session only: the PKCE
 * verifier/state pair used across the redirect to the identity provider,
 * and the resulting access/refresh token. This is the app's authentication
 * session, not a local persistence layer for clinical data — `apps/web`
 * stays online-only by explicit decision (SRS_v2 §4.2/§4.3) and never
 * caches an Observation, a stoma output value, or any other PHI here.
 * `sessionStorage` (not `localStorage`) so the session ends when the tab
 * closes rather than lingering on a shared device.
 */

const PKCE_KEY = 'ostomy.auth.pkce';
const TOKENS_KEY = 'ostomy.auth.tokens';

export interface StoredPkceState {
  readonly codeVerifier: string;
  readonly state: string;
}

export interface StoredTokens {
  readonly accessToken: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly refreshToken?: string;
}

export function savePkceState(value: StoredPkceState): void {
  sessionStorage.setItem(PKCE_KEY, JSON.stringify(value));
}

export function loadPkceState(): StoredPkceState | undefined {
  const raw = sessionStorage.getItem(PKCE_KEY);
  return parseOrClear<StoredPkceState>(raw, PKCE_KEY);
}

export function clearPkceState(): void {
  sessionStorage.removeItem(PKCE_KEY);
}

export function saveTokens(value: StoredTokens): void {
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(value));
}

export function loadTokens(): StoredTokens | undefined {
  const raw = sessionStorage.getItem(TOKENS_KEY);
  return parseOrClear<StoredTokens>(raw, TOKENS_KEY);
}

export function clearTokens(): void {
  sessionStorage.removeItem(TOKENS_KEY);
}

/**
 * Parses a stored value, discarding it if it is not valid JSON.
 *
 * `JSON.parse` was called bare on both keys. Anything malformed under them —
 * a truncated write, a schema change between deploys, another app on the same
 * origin — threw out of `initialize()` and wedged the app on "Signing you
 * in…" forever, with no error boundary and nothing rendered that could tell
 * the user to clear site data.
 *
 * Clearing rather than merely returning `undefined` matters: a value that
 * cannot be parsed will not parse on the next load either, so leaving it
 * would make every subsequent visit fail the same way.
 */
function parseOrClear<T>(raw: string | null, key: string): T | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    window.sessionStorage.removeItem(key);
    return undefined;
  }
}
