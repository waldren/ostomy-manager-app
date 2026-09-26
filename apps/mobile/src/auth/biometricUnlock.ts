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

/**
 * Wraps `expo-local-authentication` for the one thing this app uses it
 * for: gating access to the stored refresh token (`tokenStorage.ts`) on
 * every app open after the first. Never used for anything else — this is
 * not a general-purpose biometric API.
 */

export type LocalUnlockOutcome =
  | { readonly outcome: 'success' }
  /** Nothing the OS can authenticate against at all — the caller falls back to full OIDC re-login. */
  | { readonly outcome: 'unavailable' }
  /** The user cancelled or failed the prompt. The caller keeps showing the unlock prompt rather than treating this as a sign-out. */
  | { readonly outcome: 'failed' };

/**
 * The strongest thing the OS will authenticate this person with right now.
 *
 * `NONE < SECRET < BIOMETRIC_WEAK < BIOMETRIC_STRONG`, and the enum's numeric
 * order is load-bearing in two places: `isLocalUnlockAvailable` below, and
 * `tokenStorage.ts`'s enrolment-change check, which is why this is exported
 * rather than inlined.
 *
 * Deliberately NOT gated on `hasHardwareAsync()`. That reports whether a face or
 * fingerprint **scanner** exists, which is a different question from what the OS
 * will authenticate with: `getEnrolledLevelAsync()` answers `SECRET` from the
 * device's screen lock alone, on a handset with no sensor at all. Short-circuiting
 * to `NONE` there reproduced #74's second defect for every sensorless phone — the
 * same conflation of "has biometrics" with "can be authenticated" that the check
 * below exists to undo, one layer further down.
 *
 * (`SecurityLevel`'s one caveat — `SECRET` from a SIM lock alone — is documented
 * as Android before M, which is below Expo SDK 57's minimum, so it cannot occur.)
 */
export async function enrolledSecurityLevel(): Promise<LocalAuthentication.SecurityLevel> {
  return LocalAuthentication.getEnrolledLevelAsync();
}

/**
 * Whether this app can unlock the stored session locally — by biometric OR by
 * the device passcode.
 *
 * Named for unlock rather than for biometrics, because the previous name is
 * what made this wrong (#74). It asked `isEnrolledAsync()`, which on Android
 * answers for BIOMETRICS ONLY: a patient with a PIN and no fingerprint got
 * `false`, and `app/login.tsx` then offered them nothing but "Sign in again
 * instead" — a network OIDC login. So an unenrolled patient had no offline
 * route into their own diary, on the one client that exists to work offline.
 *
 * Nothing else in the design agreed with that check. `authenticate()` below
 * passes `disableDeviceFallback: false` on purpose, so the OS would have
 * accepted the passcode had it been asked; `login.unlockHint` promises "Use
 * your face, fingerprint, or phone passcode"; and `login.unlockUnavailableBody`
 * tells the patient their phone has no "passcode unlock turned on" — a claim
 * the code never checked. ADR-0015 had already rejected
 * `disableDeviceFallback: true` for exactly this population ("post-surgical
 * hands, dry skin, tremor"), so this restores the decision the ADR made rather
 * than changing it.
 *
 * `SECRET` therefore counts. `NONE` does not, and that is the only case where a
 * full re-login is genuinely the patient's only way in.
 */
export async function isLocalUnlockAvailable(): Promise<boolean> {
  return (await enrolledSecurityLevel()) !== LocalAuthentication.SecurityLevel.NONE;
}

/**
 * Prompts for Face ID / Touch ID / Android biometric or device-credential
 * fallback. `disableDeviceFallback: false` (the default) deliberately: a
 * patient population that skews older and post-surgical benefits from the
 * device passcode fallback when a fingerprint reader fails to read a
 * bandaged hand, and this app has no weaker "PIN" flow of its own to fall
 * back to instead.
 */
export async function authenticate(promptMessage: string): Promise<LocalUnlockOutcome> {
  if (!(await isLocalUnlockAvailable())) {
    return { outcome: 'unavailable' };
  }

  const result = await LocalAuthentication.authenticateAsync({
    // Class 3 only. The default is 'weak', which also admits Android
    // Class 2 biometrics — including 2D camera face unlock, defeatable
    // with a photograph on many implementations. On a mid-range Android
    // phone that would be what stands between a stranger and the
    // patient's full clinical history.
    biometricsSecurityLevel: 'strong',
    promptMessage,
  });
  return result.success ? { outcome: 'success' } : { outcome: 'failed' };
}
