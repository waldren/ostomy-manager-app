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

import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

import { enrolledSecurityLevel } from './biometricUnlock';

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
 *
 * ## Where that flag cannot be set at all
 *
 * On a device with no Class 3 biometric enrolled the flag cannot be honoured:
 * the write itself is rejected, so setting it unconditionally did not harden the
 * token, it prevented the patient from signing in (#74). `UNGATED_TOKEN_OPTIONS`
 * below is that case, and `storedTokenIsStaleForEnrolment` is what replaces the
 * lost invalidation signal for it.
 */
const REFRESH_TOKEN_KEY = 'ostomy.auth.refreshToken';

/**
 * The gated option set — used whenever the OS will accept it.
 *
 * `expo-secure-store` looks up an entry by key AND options, and reading with
 * different options than it was written with silently returns `null` rather than
 * erroring, which presents as "the patient is signed out" on every cold start.
 * There are now two option sets, so no call site may pick one by guessing:
 * `setRefreshToken` records which was used and every read goes through
 * `readMarker`. That indirection is the whole reason the marker holds a value
 * rather than a constant.
 */
const GATED_TOKEN_OPTIONS: SecureStore.SecureStoreOptions = {
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

/**
 * The same entry WITHOUT the biometric gate, for a device that has no biometric
 * enrolled at all.
 *
 * ## Why this exists (#74)
 *
 * `requireAuthentication: true` cannot be *written* on Android unless a Class 3
 * biometric is already enrolled — the keystore key it creates specifies
 * `AUTH_BIOMETRIC_STRONG`, so `setItemAsync` rejects outright:
 *
 * ```
 * 'ExpoSecureStore.setValueWithKeyAsync' has been rejected.
 * → Caused by: Could not Authenticate the user: No biometrics are currently enrolled
 * ```
 *
 * That rejection came out of `AuthContext`'s `completeLogin` AFTER a successful
 * code exchange, so a patient with no fingerprint could not sign in at all —
 * online or off — and was told "We could not sign you in. Please try again.",
 * advice that cannot work no matter how many times it is followed. The app was
 * unusable for them, which is not a posture anyone chose: ADR-0015 records the
 * opposite intent, having rejected `disableDeviceFallback: true` specifically so
 * that patients whose biometrics fail to enrol keep access to their own diary.
 *
 * ## What is given up, and what replaces it
 *
 * The OS invalidation-on-enrolment-change signal, which is the entire reason the
 * flag is set. `storedTokenIsStaleForEnrolment()` below reimplements the part of
 * it that matters here, and it can, for a reason specific to this case: ADR-0015
 * says an app cannot detect an enrolment CHANGE, which is true of "a second
 * fingerprint added when one already exists" — the reported level is
 * `BIOMETRIC_STRONG` before and after. But an entry stored ungated is by
 * definition one stored with NO biometric enrolled, and going from none to one
 * RAISES `getEnrolledLevelAsync()`. That transition is observable, and it is
 * exactly the covert-enrolment scenario ADR-0015 is about.
 *
 * So the rule is: gate it when the OS will let us, and when it will not, watch
 * the level and purge on a rise. See ADR-0015's "Amended at #74" section.
 */
const UNGATED_TOKEN_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * A non-authenticated marker recording that a refresh token exists.
 *
 * `hasStoredRefreshToken` used to answer by READING the token, which after
 * `requireAuthentication` became a biometric-gated read. Two consequences,
 * both shipped:
 *
 * 1. The OS auth sheet appeared at cold start, before the app had rendered
 *    its own unlock affordance, with OS default copy — and then the patient
 *    authenticated a SECOND time when they pressed Unlock. The comment
 *    below about the prompt being "this app's own" did not describe the
 *    built behaviour.
 * 2. That read rejects when the patient cancels it, when biometry is locked
 *    out after failed attempts, or when the OS has invalidated the key. The
 *    caller had no error path, so `phase` stayed `'checking'` and the app
 *    sat on a spinner with no way out but reinstalling — which destroys the
 *    database.
 *
 * The marker carries no secret: its presence says a token exists, nothing
 * more. It is written and cleared in lockstep with the token itself.
 */
const REFRESH_TOKEN_MARKER_KEY = 'ostomy.auth.refreshTokenPresent';

// Deliberately the same shape as `UNGATED_TOKEN_OPTIONS` and for a different
// reason: this entry must be readable without a prompt (that is the whole point
// of a marker), whereas that one is ungated only because the OS refuses to gate
// it. Kept separate so that changing one does not silently change the other.
const MARKER_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/** Which option set the stored token was written with. */
type TokenProtection = 'gated' | 'ungated';

interface StoredTokenMarker {
  readonly protection: TokenProtection;
  /**
   * `enrolledSecurityLevel()` at the moment the token was written.
   *
   * Only meaningful for an `ungated` token, where it is the baseline a later
   * enrolment is compared against. Recorded for a gated one too, because the OS
   * is doing the invalidation there and a value that disagrees with the
   * protection mode is a bug worth being able to see.
   */
  readonly enrolledLevel: number;
}

/**
 * Builds before #74 wrote the literal `'1'`.
 *
 * Those entries are `gated` by definition — an ungated one could not exist yet.
 * Handled rather than ignored because an unparseable marker makes this module
 * read the token with the wrong options, and the module comment above records
 * what that does: it returns `null` silently, which presents as the patient
 * being signed out of a session they still have.
 */
const LEGACY_MARKER_VALUE = '1';

function isTokenProtection(value: unknown): value is TokenProtection {
  return value === 'gated' || value === 'ungated';
}

async function readMarker(): Promise<StoredTokenMarker | null> {
  const raw = await SecureStore.getItemAsync(REFRESH_TOKEN_MARKER_KEY, MARKER_OPTIONS);
  if (raw === null) return null;

  // Anything this build cannot read is treated as the pre-#74 shape, which is
  // the safe direction: guessing `gated` for a token that is actually ungated
  // costs one re-login, and guessing `ungated` for a gated one costs the same.
  // Neither can lock the patient out, and `gated` is what every build before
  // this one wrote.
  const legacy: StoredTokenMarker = {
    protection: 'gated',
    enrolledLevel: LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG,
  };
  if (raw === LEGACY_MARKER_VALUE) return legacy;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return legacy;
    const { protection, enrolledLevel } = parsed as Record<string, unknown>;
    if (!isTokenProtection(protection) || typeof enrolledLevel !== 'number') return legacy;
    return { protection, enrolledLevel };
  } catch {
    return legacy;
  }
}

function optionsFor(marker: StoredTokenMarker): SecureStore.SecureStoreOptions {
  return marker.protection === 'gated' ? GATED_TOKEN_OPTIONS : UNGATED_TOKEN_OPTIONS;
}

export async function getRefreshToken(): Promise<string | null> {
  // Via the marker, because the options must match what wrote the entry — see
  // `GATED_TOKEN_OPTIONS`' comment on what a mismatch does. No marker means no
  // token, so there is nothing to prompt for.
  const marker = await readMarker();
  if (marker === null) return null;
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY, optionsFor(marker));
}

export async function setRefreshToken(token: string): Promise<void> {
  const enrolledLevel = await enrolledSecurityLevel();

  // `BIOMETRIC_STRONG`, not merely "something is enrolled": `requireAuthentication`
  // creates its keystore key with `AUTH_BIOMETRIC_STRONG`, so a device with only a
  // passcode (`SECRET`) or only a Class 2 sensor (`BIOMETRIC_WEAK`) rejects the
  // write. That rejection is #74 — it surfaced out of `completeLogin` AFTER a
  // successful code exchange, so it made the app unusable rather than degraded.
  //
  // Decided from the level rather than by attempting the gated write and catching
  // its failure, on purpose. A catch would also swallow a gated write that failed
  // for some OTHER reason on a device where gating IS possible, silently storing a
  // credential with less protection than the device can provide and than ADR-0015
  // requires. Here that failure still propagates, exactly as it did before.
  const protection: TokenProtection =
    enrolledLevel >= LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG ? 'gated' : 'ungated';

  await SecureStore.setItemAsync(
    REFRESH_TOKEN_KEY,
    token,
    protection === 'gated' ? GATED_TOKEN_OPTIONS : UNGATED_TOKEN_OPTIONS,
  );
  const marker: StoredTokenMarker = { protection, enrolledLevel };
  await SecureStore.setItemAsync(REFRESH_TOKEN_MARKER_KEY, JSON.stringify(marker), MARKER_OPTIONS);
}

export async function clearRefreshToken(): Promise<void> {
  // Marker first. If the second call fails, the app believes there is no
  // token and routes to a full sign-in — recoverable. The reverse order
  // would leave a marker with no token, routing to an unlock that can
  // never succeed.
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_MARKER_KEY, MARKER_OPTIONS);
  // Both option sets, because the marker naming which one wrote the token has
  // just been deleted and lookup is by key AND options. Leaving the entry behind
  // would leave a live bearer credential on a device the patient believes they
  // have signed out of.
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, GATED_TOKEN_OPTIONS);
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, UNGATED_TOKEN_OPTIONS);
}

/**
 * Whether a refresh token exists, WITHOUT reading it and therefore without
 * prompting. See `REFRESH_TOKEN_MARKER_KEY`.
 */
export async function hasStoredRefreshToken(): Promise<boolean> {
  return (await readMarker()) !== null;
}

/**
 * Whether the stored token must be discarded because biometric enrolment has
 * appeared since it was written (#74).
 *
 * This stands in for the OS invalidation an ungated entry does not get, and it is
 * only able to because of what "ungated" implies. ADR-0015 says an app cannot
 * detect an enrolment change — true where a biometric already exists, since
 * `getEnrolledLevelAsync()` reports `BIOMETRIC_STRONG` both before and after a
 * second fingerprint is added. But a token stored ungated was stored with NO
 * biometric enrolled, so any enrolment raises the level, and that is observable.
 * It is also precisely ADR-0015's threat: someone who covertly adds their own
 * biometric to the patient's phone.
 *
 * A rise forces a full OIDC re-login, which is the same consequence ADR-0015
 * specifies for the gated case, reached by a different mechanism. It also
 * upgrades the protection for free: the token written after that login is gated,
 * because the level now permits it.
 *
 * What it does NOT catch, stated plainly: a passcode changed while remaining a
 * passcode (`SECRET` to `SECRET`), and tampering with the marker itself, which is
 * ungated by necessity. Both need the attacker to have the device already
 * unlocked, at which point they can read the diary regardless.
 */
export async function storedTokenIsStaleForEnrolment(): Promise<boolean> {
  const marker = await readMarker();
  if (marker === null || marker.protection === 'gated') return false;
  return (await enrolledSecurityLevel()) > marker.enrolledLevel;
}
