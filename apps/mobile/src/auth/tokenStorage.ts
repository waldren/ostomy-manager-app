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
 * `AsyncStorage`, for either token: CLAUDE.md's standing rule is "never
 * store PHI or tokens in AsyncStorage", and a refresh token is a bearer
 * credential regardless of whether it carries PHI directly.
 *
 * ## Why `requireAuthentication` is set, when the app also gates at its
 * ## own layer
 *
 * `AuthContext.tsx` still calls `biometricUnlock.ts`'s `authenticate()`
 * before reading this token, so the prompt the patient normally sees is
 * this app's own with this app's copy. That has not changed. This flag is
 * not here for the prompt — it is here for what the OS does to the key
 * when biometric enrolment changes.
 *
 * `requireAuthentication` maps to iOS `biometryCurrentSet` and Android
 * `setUserAuthenticationRequired(true)`, and the module documents the
 * consequence: *"Keys are invalidated by the system when biometrics
 * change, such as adding a new fingerprint or changing the face profile
 * used for face recognition. After a key has been invalidated, it becomes
 * impossible to read its value."*
 *
 * That invalidation is the whole point, and it is not something this app
 * can implement itself: `expo-local-authentication` exposes only current
 * state (`hasHardwareAsync`, `isEnrolledAsync`, `getEnrolledLevelAsync`),
 * never a change signal, so there is no way to detect at the app layer
 * that a second fingerprint or face was enrolled.
 *
 * The threat it closes is not an abstract one. Someone who covertly or
 * coercively adds their own biometric to the patient's device — an abusive
 * partner, a family member, a border or custody enrolment — otherwise gets
 * permanent, silent access to the entire local diary and to a live bearer
 * credential. Because unlock deliberately involves no issuer round trip
 * (see `AuthContext.tsx`), there is no server-side event either: no audit
 * trail of the access, and no way for the patient or the covered entity
 * ever to discover it. With this flag, an enrolment change makes the
 * stored token unreadable and forces a full OIDC re-login, which does
 * reach the issuer and does leave a record.
 *
 * This is a separate decision from "biometric alone grants local access",
 * which remains true and is what keeps the app usable offline. See
 * ADR-0015.
 */
const REFRESH_TOKEN_KEY = 'ostomy.auth.refreshToken';

/**
 * Shared by every call, because `expo-secure-store` looks up an entry by
 * key AND options: reading with different options than it was written with
 * silently returns `null` rather than erroring, which would present as
 * "the patient is signed out" on every cold start.
 */
const REFRESH_TOKEN_OPTIONS: SecureStore.SecureStoreOptions = {
  // Bound to THIS device. Not plain `AFTER_FIRST_UNLOCK`: that variant is
  // migrated to a new device when restoring from a backup, so an encrypted
  // iCloud/iTunes backup restored onto a second phone would hand that
  // phone a live bearer credential for the patient's account. The
  // `_THIS_DEVICE_ONLY` suffix keeps the locked-device readability this
  // app needs for background refresh while removing the migration path.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  // See the module comment. Present on every call for the reason above.
  requireAuthentication: true,
};

export async function getRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY, REFRESH_TOKEN_OPTIONS);
}

export async function setRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, REFRESH_TOKEN_OPTIONS);
}

export async function clearRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, REFRESH_TOKEN_OPTIONS);
}

export async function hasStoredRefreshToken(): Promise<boolean> {
  return (await getRefreshToken()) !== null;
}
