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

export type BiometricUnlockOutcome =
  | { readonly outcome: 'success' }
  /** No enrolled biometrics/passcode, or no hardware — the caller falls back to full OIDC re-login. */
  | { readonly outcome: 'unavailable' }
  /** The user cancelled or failed the prompt. The caller keeps showing the unlock prompt rather than treating this as a sign-out. */
  | { readonly outcome: 'failed' };

export async function isBiometricUnlockAvailable(): Promise<boolean> {
  const [hasHardware, isEnrolled] = await Promise.all([
    LocalAuthentication.hasHardwareAsync(),
    LocalAuthentication.isEnrolledAsync(),
  ]);
  return hasHardware && isEnrolled;
}

/**
 * Prompts for Face ID / Touch ID / Android biometric or device-credential
 * fallback. `disableDeviceFallback: false` (the default) deliberately: a
 * patient population that skews older and post-surgical benefits from the
 * device passcode fallback when a fingerprint reader fails to read a
 * bandaged hand, and this app has no weaker "PIN" flow of its own to fall
 * back to instead.
 */
export async function authenticate(promptMessage: string): Promise<BiometricUnlockOutcome> {
  if (!(await isBiometricUnlockAvailable())) {
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
