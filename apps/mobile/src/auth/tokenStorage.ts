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
 * Reading an entry with different options than it was written with can silently
 * return `null` rather than erroring, which presents as "the patient is signed out"
 * on every cold start. There are now two option sets, so no call site may pick one
 * by guessing: `setRefreshToken` records which was used and every read goes through
 * `readMarker`.
 *
 * Worth being exact about where that failure lives, since the comments here are
 * meant to be true of the shipping platform. On **iOS** the keychain query
 * includes the accessibility class, so a mismatch really does miss the entry. On
 * **Android** the preference key is `keychainService-key`, `requireAuthentication`
 * is stored inside the entry and read back from there, and the keystore alias is
 * derived from the *stored* flag — so a mismatched read still resolves, and this
 * indirection buys nothing on Android today beyond being right. It is kept because
 * it is the correct shape for both platforms and because guessing would become a
 * silent bug the moment iOS is reinstated, not because Android needs it.
 */
const GATED_TOKEN_OPTIONS: SecureStore.SecureStoreOptions = {
  // Bound to THIS device. Not plain `AFTER_FIRST_UNLOCK`: that variant is
  // migrated to a new device when restoring from a backup, so an encrypted
  // iCloud/iTunes backup restored onto a second phone would hand that
  // phone a live bearer credential for the patient's account. The
  // `_THIS_DEVICE_ONLY` suffix keeps the locked-device readability this
  // app needs for background refresh while removing the migration path.
  //
  // **`keychainAccessible` is iOS-only** and is discarded on Android, where
  // `SecureStoreOptions` has only `authenticationPrompt`, `keychainService` and
  // `requireAuthentication`. The no-migration property still holds on the platform
  // v1 actually ships (ADR-0020), by a different mechanism: the AES key lives in
  // AndroidKeyStore and is non-exportable, so ciphertext restored onto another
  // phone has no key to decrypt it. This constant is therefore correct and inert
  // here, and load-bearing for the phase that reinstates iOS.
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
  const [existing, enrolledLevel] = await Promise.all([readMarker(), enrolledSecurityLevel()]);

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
  const deviceCanGateNow = enrolledLevel >= LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG;

  // ...but a live level read is not proof the device CANNOT gate, and this is the
  // second half of the same argument. `getEnrolledLevelAsync` reports
  // `BIOMETRIC_STRONG` only while `canAuthenticate(BIOMETRIC_STRONG)` answers
  // SUCCESS, so a transient state — a sensor locked out after failed attempts,
  // `BIOMETRIC_ERROR_HW_UNAVAILABLE`, the documented post-OTA
  // `BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED` — reads as `SECRET` on a phone with
  // a fingerprint enrolled.
  //
  // Deciding from that read alone had two consequences, and the second is worse
  // than the first. A token that could be gated would be rewritten ungated, which
  // is exactly the silent downgrade the paragraph above refuses. And the recorded
  // baseline would become `SECRET`, so the next cold start would see a rise to
  // `BIOMETRIC_STRONG` and purge — signing the patient out, and telling them their
  // unlock settings changed, for something that never happened. Offline they could
  // not complete the re-login at all.
  //
  // So an existing gated marker is treated as standing evidence that this device
  // supports gating: keep gating, and let a rejection propagate. A device that has
  // GENUINELY lost its biometric does not reach here with a gated marker, because
  // `storedTokenIsStaleForEnrolment` purges that token — marker included — at the
  // cold start before this.
  const gated = deviceCanGateNow || existing?.protection === 'gated';

  await SecureStore.setItemAsync(
    REFRESH_TOKEN_KEY,
    token,
    gated ? GATED_TOKEN_OPTIONS : UNGATED_TOKEN_OPTIONS,
  );

  // Marker last. A rejected token write must not leave a marker behind: the app
  // would then believe it has a session and route to an unlock that can never
  // succeed, which is the same failure `clearRefreshToken` orders its deletes to
  // avoid. `BIOMETRIC_STRONG` for a gated entry because that is what the write it
  // just completed required and demonstrated — recording a transiently low read
  // there would be the false baseline this function exists to avoid.
  const marker: StoredTokenMarker = gated
    ? { protection: 'gated', enrolledLevel: LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG }
    : { protection: 'ungated', enrolledLevel };
  await SecureStore.setItemAsync(REFRESH_TOKEN_MARKER_KEY, JSON.stringify(marker), MARKER_OPTIONS);
}

export async function clearRefreshToken(): Promise<void> {
  // Marker first. If the second call fails, the app believes there is no
  // token and routes to a full sign-in — recoverable. The reverse order
  // would leave a marker with no token, routing to an unlock that can
  // never succeed.
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_MARKER_KEY, MARKER_OPTIONS);
  // Both option sets, because the marker naming which one wrote the token has just
  // been deleted, and on iOS the keychain query includes the accessibility class.
  // (On Android the preference key is `keychainService-key` and both calls hit the
  // same entry, so the second is redundant there — `signOut`'s own comment makes
  // the same platform distinction.)
  //
  // `allSettled`, not sequential awaits: the comment below is about not leaving a
  // live bearer credential on a device the patient believes they have signed out
  // of, and a first rejection skipping the second attempt would be that outcome
  // arrived at by the code meant to prevent it. `signOut` applies the same
  // discipline for the same reason.
  const deletes = await Promise.allSettled([
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, GATED_TOKEN_OPTIONS),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, UNGATED_TOKEN_OPTIONS),
  ]);
  // Rethrow only when NEITHER attempt got anywhere, so a caller still learns the
  // token may survive. One success means the entry is gone.
  const firstRejection = deletes.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (firstRejection !== undefined && deletes.every((result) => result.status === 'rejected')) {
    throw firstRejection.reason;
  }
}

/**
 * Whether a refresh token exists, WITHOUT reading it and therefore without
 * prompting. See `REFRESH_TOKEN_MARKER_KEY`.
 */
export async function hasStoredRefreshToken(): Promise<boolean> {
  return (await readMarker()) !== null;
}

/**
 * Records that the app signed the patient out because the device's unlock settings
 * changed, so the login screen can say so.
 *
 * ## Why this is persisted rather than held in React state
 *
 * The purge deletes the marker, so `storedTokenIsStaleForEnrolment()` answers
 * `false` from then on and the reason cannot be re-derived. State in the provider
 * would therefore survive exactly one launch — and one launch is not enough,
 * because the remedy is a **network** OIDC login. A patient who enrolled a
 * fingerprint and opened the app offline cannot complete it, so they close the app
 * and come back later, which is the likely path through this state rather than an
 * edge of it. Second time around they would see a bare "Sign in to your diary"
 * over what looks like an empty diary, with nothing accounting for either.
 *
 * Cleared when a sign-in actually succeeds, not when one is attempted: a patient
 * who fails an attempt should not lose the explanation.
 *
 * Carries no secret and no PHI — it is one enum value — and it is ungated for the
 * same reason the marker is: it has to be readable before anything prompts.
 */
const SIGNED_OUT_REASON_KEY = 'ostomy.auth.signedOutReason';

/**
 * Deliberately one value covering both directions of change.
 *
 * A biometric can appear (an ungated token, ADR-0015's covert-enrolment threat) or
 * go away (a gated token whose key the OS has now invalidated), and the copy must
 * not name the patient as the actor in either case: the whole point of the first
 * is that someone else may have done it.
 */
export type SignedOutReason = 'unlock-settings-changed';

export async function recordSignedOutReason(reason: SignedOutReason): Promise<void> {
  await SecureStore.setItemAsync(SIGNED_OUT_REASON_KEY, reason, MARKER_OPTIONS);
}

export async function readSignedOutReason(): Promise<SignedOutReason | null> {
  const raw = await SecureStore.getItemAsync(SIGNED_OUT_REASON_KEY, MARKER_OPTIONS);
  return raw === 'unlock-settings-changed' ? raw : null;
}

export async function clearSignedOutReason(): Promise<void> {
  await SecureStore.deleteItemAsync(SIGNED_OUT_REASON_KEY, MARKER_OPTIONS);
}

/**
 * Whether the stored token must be discarded because the device's enrolment state
 * changed in a way that makes it either unreadable or unprotected (#74).
 *
 * Two cases, and they are mirror images.
 *
 * ## An ungated token, and a biometric appears
 *
 * This stands in for the OS invalidation an ungated entry does not get, and it is
 * only able to because of what "ungated" implies. ADR-0015 says an app cannot
 * detect an enrolment change — true where a biometric already exists, since
 * `getEnrolledLevelAsync()` reports the same level before and after a second
 * fingerprint is added. But a token stored ungated on a device at `NONE` or
 * `SECRET` was stored with no biometric enrolled at all, so a first enrolment
 * raises the level, and that is observable. It is also precisely ADR-0015's threat:
 * someone who covertly adds their own biometric to the patient's phone.
 *
 * **Not** every ungated token, though, and the difference matters because it is
 * easy to state this rule too strongly. A `BIOMETRIC_WEAK` device also takes the
 * ungated path — a Class 2 sensor cannot back an `AUTH_BIOMETRIC_STRONG` key — and
 * there the level is `BIOMETRIC_WEAK` before and after a second face is enrolled,
 * so that covert enrolment is NOT detected. The exposure is narrow, since enrolling
 * requires the device credential, which already satisfies this app's own prompt.
 * It is listed below rather than left to be rediscovered.
 *
 * The purge also upgrades the protection for free where it can: the token written
 * by the forced re-login is gated, if the new level permits it.
 *
 * ## A gated token whose key is gone is NOT decided here
 *
 * That state is real and worth handling — making local unlock accept the device
 * passcode opened a route to it that did not exist before, where the patient
 * authenticates with their PIN, reaches `authenticated`, and the token read yields
 * nothing, so no access token ever arrives and nothing syncs while every screen
 * truthfully reports entries saved.
 *
 * But it must not be inferred from the level, and the reason is the same one that
 * shapes `setRefreshToken`. `getEnrolledLevelAsync` drops to `SECRET` on a phone
 * with a fingerprint whenever `canAuthenticate(BIOMETRIC_STRONG)` is momentarily
 * not SUCCESS — a sensor locked out after failed attempts, `HW_UNAVAILABLE`, the
 * post-OTA `SECURITY_UPDATE_REQUIRED`. A rule of "gated and the level fell" would
 * therefore purge a perfectly good session on any launch during a lockout, which is
 * frequent, and tell the patient their unlock settings changed when they had not.
 *
 * `AuthContext`'s `unlock()` handles it instead, from ground truth: it reads the
 * token, and an invalidated key yields nothing. No inference, no false positive,
 * and nothing happens to an offline patient who does not need the token yet.
 *
 * ## The residual false positive, stated rather than hidden
 *
 * The rise rule above is safe against that transient state in every case but one,
 * because a momentary `canAuthenticate` failure LOWERS the reported level and a
 * lower level cannot look like a rise. The exception is a first-ever sign-in that
 * happens during such a moment on a phone that does have a strong biometric: the
 * token is stored ungated with a low baseline, and the next launch reads a rise.
 * The cost is one spurious re-login, after which the token is gated correctly. It
 * needs a network, so it is not free, and it is the one case where this mechanism
 * can sign out a patient who did nothing.
 *
 * ## What neither case catches, stated plainly
 *
 * A passcode changed while remaining a passcode (`SECRET` to `SECRET`); a second
 * Class 2 biometric enrolled on a `BIOMETRIC_WEAK` device, per the paragraph above;
 * a second fingerprint added to a device that already had a strong one (the OS
 * handles that one, which is the whole point of the gated case); and tampering with
 * the marker itself, which is ungated by necessity. The last needs the attacker to
 * have the device already unlocked, at which point they can read the diary
 * regardless.
 *
 * It is also checked at two moments only — cold start and unlock — so an enrolment
 * that lands while the process is alive is not noticed until one of those. The
 * gated case has no such window, because the OS invalidates the key immediately.
 * The two mechanisms differ in timing, and that difference is not a detail the
 * amendment should have left implicit.
 */
export async function storedTokenIsStaleForEnrolment(): Promise<boolean> {
  const marker = await readMarker();
  // A gated token is the OS's to invalidate, and `unlock()` detects the result by
  // reading it. See the comment above for why this must not guess from the level.
  if (marker === null || marker.protection === 'gated') return false;
  // Strictly greater: a level that FELL means the patient removed a screen lock,
  // which hands nobody anything. Signing them out of an offline diary for it would
  // be a lockout with no threat behind it.
  return (await enrolledSecurityLevel()) > marker.enrolledLevel;
}
