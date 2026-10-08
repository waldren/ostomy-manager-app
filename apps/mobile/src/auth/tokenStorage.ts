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
 * ## Why `requireAuthentication` is NOT set (ADR-0015 Amendment 2, #116)
 *
 * It was, from ADR-0015 until #116, and the reasoning then was sound: the flag
 * maps to iOS `biometryCurrentSet` and Android `setUserAuthenticationRequired`,
 * so the OS invalidates the key when biometric enrolment changes. That closed a
 * threat this app cannot otherwise see — someone who covertly or coercively adds
 * their own biometric to the patient's device gets no server-side event, because
 * unlock deliberately involves no issuer round trip, so without the flag they had
 * permanent silent access to a live bearer credential.
 *
 * Two things retired it.
 *
 * **It made the device passcode impossible.** `expo-secure-store` raises its own
 * prompt when a gated entry is read, built with a negative button and no allowed
 * authenticators — a combination Android forbids pairing with `DEVICE_CREDENTIAL`.
 * That prompt is biometric-only by construction, at any setting. So a patient who
 * cleared this app's own gate with their passcode was stopped by a second gate the
 * app does not control, and `unlock()` read the failure as `unreadable` and
 * re-locked: the unlock button appeared to do nothing, forever (#116). ADR-0015 had
 * already refused that exclusion twice, for "post-surgical hands, dry skin,
 * tremor".
 *
 * **And the guarantee defended against an escalation that no longer exists.** It
 * was worth its cost because biometric was the only authenticator the gate
 * accepted, so enrolling one granted an attacker something they did not have.
 * Enrolling a biometric on Android requires the device credential — which, since
 * Amendment 2, unlocks this app. The invalidation now fires on a transition that
 * grants nothing, and its only reliable effect is signing a legitimate patient out
 * into a network login they may not be able to complete.
 *
 * **What this gives up, and it is real.** Someone who knows the device passcode and
 * has no enrolled biometric now obtains the refresh token. They could already read
 * the entire local diary — ADR-0014 leaves the SQLCipher key ungated — so the new
 * exposure is the account credential, not the clinical history.
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` still applies, so it cannot ride a backup
 * onto another phone.
 *
 * **Do not "restore" this flag as an obvious hardening.** It is the exact change
 * that locks a patient out of their own diary, and the unit tests cannot see it:
 * jest presents no biometric to an OS prompt, and two of the tests covering this
 * path held the defect in place rather than catching it.
 */
const REFRESH_TOKEN_KEY = 'ostomy.auth.refreshToken';

/**
 * The one option set. There is no second one since Amendment 2 — see the module
 * comment for why `requireAuthentication` is absent.
 *
 * Reading an entry with different options than it was written with can silently
 * return `null` rather than erroring, which presents as "the patient is signed out"
 * on every cold start. With a single set there is nothing to pick wrongly; the
 * marker below still exists, but it no longer carries a protection class.
 *
 * Worth being exact about where that failure lives, since the comments here are
 * meant to be true of the shipping platform. On **iOS** the keychain query includes
 * the accessibility class, so a mismatch really does miss the entry. On **Android**
 * the preference key is `keychainService-key`, `requireAuthentication` is stored
 * inside the entry and read back from there, and the keystore alias is derived from
 * the *stored* flag — so a mismatched read still resolves. That asymmetry is why
 * the migration below is explicit rather than left to a failed read.
 */
const TOKEN_OPTIONS: SecureStore.SecureStoreOptions = {
  // Bound to THIS device. Not plain `AFTER_FIRST_UNLOCK`: that variant is migrated
  // to a new device when restoring from a backup, so an encrypted iCloud/iTunes
  // backup restored onto a second phone would hand that phone a live bearer
  // credential for the patient's account. The `_THIS_DEVICE_ONLY` suffix keeps the
  // locked-device readability this app needs for background refresh while removing
  // the migration path.
  //
  // **`keychainAccessible` is iOS-only** and is discarded on Android. The
  // no-migration property still holds on the platform v1 ships (ADR-0020) by a
  // different mechanism: the AES key lives in AndroidKeyStore and is
  // non-exportable, so ciphertext restored onto another phone has no key to
  // decrypt it. Unaffected by Amendment 2 and kept deliberately.
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

// Deliberately the same shape as `TOKEN_OPTIONS`, and since Amendment 2 that is
// no longer a coincidence worth guarding: the token is ungated too. Kept as its
// own constant because the REASONS differ — a marker must be readable without a
// prompt because being readable without a prompt is the entire point of it,
// whereas the token is ungated by the decision in the module comment. If one of
// those reasons ever changes, the other should not change with it silently.
const MARKER_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

/**
 * The marker value this build writes.
 *
 * It is a version, not a flag, and that is the whole migration (#116). Every
 * earlier build stored a token that MAY have been written with
 * `requireAuthentication` — `'1'` before #74, a JSON `{ protection, enrolledLevel }`
 * after it. Such an entry cannot be read without the flag, and this build no longer
 * sets it, so the token behind any older marker is unreachable.
 *
 * Reaching it is not the goal; recognising it is. A mismatched read returns `null`
 * on iOS and silently resolves on Android, so without this sentinel the two
 * platforms would disagree about whether a session exists, and on iOS the patient
 * would look signed out of a session the app still believed in. `readMarker` treats
 * anything that is not this value as a token to discard, which costs one re-login
 * and is why ADR-0015 Amendment 2 records a forced sign-in on upgrade.
 */
const MARKER_VALUE = '2';

/**
 * Whether a usable token is recorded.
 *
 * `null` means no session. `'stale'` means one was stored by a build that gated it,
 * which this build cannot read — the caller clears it rather than reporting a
 * session that can never be unlocked.
 */
type MarkerState = 'present' | 'stale' | null;

async function readMarker(): Promise<MarkerState> {
  const raw = await SecureStore.getItemAsync(REFRESH_TOKEN_MARKER_KEY, MARKER_OPTIONS);
  if (raw === null) return null;
  return raw === MARKER_VALUE ? 'present' : 'stale';
}

/**
 * Discards a token written by a pre-Amendment-2 build.
 *
 * Deliberately NOT a silent `return null` from `getRefreshToken`. A gated entry
 * left on disk with its marker removed would be re-read on the next call and found
 * stale again, and an entry left WITH its marker would route the patient to an
 * unlock that can never succeed — which is #116's symptom, reintroduced by the code
 * meant to retire it. Clearing both is the only state that settles.
 */
async function discardStaleToken(): Promise<void> {
  await clearRefreshToken();
}

export async function getRefreshToken(): Promise<string | null> {
  const marker = await readMarker();
  if (marker === null) return null;
  if (marker === 'stale') {
    await discardStaleToken();
    return null;
  }
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY, TOKEN_OPTIONS);
}

export async function setRefreshToken(token: string): Promise<void> {
  // One option set, no enrolment read, no decision to make. Amendment 2 removed
  // the gated/ungated branch this function used to carry, along with the
  // `enrolledSecurityLevel()` call that chose between them and the baseline it
  // recorded — see the module comment, and ADR-0015 Amendment 2 for why the
  // guarantee that machinery managed is no longer worth its cost.
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, TOKEN_OPTIONS);

  // Marker last, unchanged from before and for the same reason: a rejected token
  // write must not leave a marker behind, or the app believes it has a session and
  // routes to an unlock that can never succeed.
  await SecureStore.setItemAsync(REFRESH_TOKEN_MARKER_KEY, MARKER_VALUE, MARKER_OPTIONS);
}

export async function clearRefreshToken(): Promise<void> {
  // Marker first. If the second call fails, the app believes there is no
  // token and routes to a full sign-in — recoverable. The reverse order
  // would leave a marker with no token, routing to an unlock that can
  // never succeed.
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_MARKER_KEY, MARKER_OPTIONS);
  // Two deletes still, and the second is the migration's half (#116). A token
  // written by a pre-Amendment-2 build carries `requireAuthentication`, and on iOS
  // the keychain query includes the accessibility class, so deleting with this
  // build's options alone could miss it and leave a live bearer credential on a
  // device the patient believes they have signed out of. On Android both calls
  // resolve to the same `keychainService-key` entry, so the second is redundant
  // there — kept for the platform ADR-0020 defers rather than drops.
  //
  // Deleting does not authenticate, so neither call prompts.
  //
  // `allSettled`, not sequential awaits: a first rejection skipping the second
  // attempt would be exactly the outcome this is meant to prevent.
  const deletes = await Promise.allSettled([
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, TOKEN_OPTIONS),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, {
      ...TOKEN_OPTIONS,
      requireAuthentication: true,
    }),
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
  // `'stale'` counts as a session for this question on purpose: one exists on disk,
  // and the cold-start path routes to the lock screen, where `unlock()` reads the
  // token, finds it stale, and ends the session with a reason the login screen can
  // show. Answering `false` here instead would drop the patient on a bare sign-in
  // screen with no explanation — the state #40 fixed and CLAUDE.md records as "a
  // patient who meets a bare sign-in screen assumes their diary is gone".
  return (await readMarker()) !== null;
}

/**
 * Records that the app signed the patient out because the device's unlock settings
 * changed, so the login screen can say so.
 *
 * ## Why this is persisted rather than held in React state
 *
 * Ending a session deletes the marker, so the reason cannot be re-derived from
 * storage afterwards. State in the provider
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
 * Why the app ended the session, from the patient's point of view.
 *
 * `unlock-settings-changed` deliberately covers both directions of an enrolment
 * change. A biometric can appear (an ungated token, ADR-0015's covert-enrolment
 * threat) or go away (a gated token whose key the OS has now invalidated), and the
 * copy must not name the patient as the actor in either case: the whole point of
 * the first is that someone else may have done it.
 *
 * `session-expired` is separate rather than folded in, because the enrolment copy
 * makes a statement about the phone's security that would be false here — the
 * refresh token was simply rejected by the issuer (#40).
 */
export type SignedOutReason = 'unlock-settings-changed' | 'session-expired';

const SIGNED_OUT_REASONS: readonly SignedOutReason[] = [
  'unlock-settings-changed',
  'session-expired',
];

export async function recordSignedOutReason(reason: SignedOutReason): Promise<void> {
  await SecureStore.setItemAsync(SIGNED_OUT_REASON_KEY, reason, MARKER_OPTIONS);
}

export async function readSignedOutReason(): Promise<SignedOutReason | null> {
  const raw = await SecureStore.getItemAsync(SIGNED_OUT_REASON_KEY, MARKER_OPTIONS);
  // Membership rather than a single comparison, so adding a reason cannot silently
  // read back as "no reason" and put the patient on a bare sign-in screen again.
  return SIGNED_OUT_REASONS.find((reason) => reason === raw) ?? null;
}

export async function clearSignedOutReason(): Promise<void> {
  await SecureStore.deleteItemAsync(SIGNED_OUT_REASON_KEY, MARKER_OPTIONS);
}
