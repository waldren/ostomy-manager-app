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
  return raw ? (JSON.parse(raw) as StoredPkceState) : undefined;
}

export function clearPkceState(): void {
  sessionStorage.removeItem(PKCE_KEY);
}

export function saveTokens(value: StoredTokens): void {
  sessionStorage.setItem(TOKENS_KEY, JSON.stringify(value));
}

export function loadTokens(): StoredTokens | undefined {
  const raw = sessionStorage.getItem(TOKENS_KEY);
  return raw ? (JSON.parse(raw) as StoredTokens) : undefined;
}

export function clearTokens(): void {
  sessionStorage.removeItem(TOKENS_KEY);
}
