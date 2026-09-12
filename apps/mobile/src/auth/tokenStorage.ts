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

import * as SecureStore from 'expo-secure-store';

/**
 * The **only** place this app persists the OIDC refresh token, and the
 * **only** token this app ever persists at all. The access token lives in
 * memory only (`AuthContext.tsx`), for as long as the app process is
 * alive, and is re-derived from the refresh token (after a biometric
 * unlock — see `biometricUnlock.ts`) on every cold start. Never
 * `AsyncStorage`, for either token: CLAUDE.md/the HIPAA reviewer's
 * standing rule is "never store PHI or tokens in AsyncStorage", and a
 * refresh token is a bearer credential regardless of whether it carries
 * PHI directly.
 *
 * This module does **not** gate reading the token on a biometric prompt
 * itself (`expo-secure-store`'s own `requireAuthentication` option would
 * do that, but with device- and OS-version-dependent UX that this app
 * does not control). Instead, `AuthContext.tsx` calls
 * `biometricUnlock.ts`'s `authenticate()` first and only calls
 * `getRefreshToken()` after it resolves successfully — gating access at
 * the application layer, deliberately, so the prompt and its copy are
 * this app's own rather than whatever the OS default happens to be.
 */
const REFRESH_TOKEN_KEY = 'ostomy.auth.refreshToken';

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function setRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, {
    // Accessible once the device has been unlocked at least once since
    // boot, and stays accessible thereafter even while the device is
    // locked again — not `WHEN_UNLOCKED` (which would make the token
    // unreadable, and therefore refresh-sync impossible, while the device
    // is merely locked in the patient's pocket) and not `ALWAYS`
    // (deprecated, and offers no restart-only protection at all).
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
}

export async function clearRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
}

export async function hasStoredRefreshToken(): Promise<boolean> {
  return (await getRefreshToken()) !== null;
}
