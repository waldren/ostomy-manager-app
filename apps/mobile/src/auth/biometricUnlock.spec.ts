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

const mockHasHardwareAsync = jest.fn();
const mockGetEnrolledLevelAsync = jest.fn();
const mockAuthenticateAsync = jest.fn();

jest.mock('expo-local-authentication', () => ({
  // Real numeric values, because their ORDER is what the module compares on.
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  hasHardwareAsync: (...args: unknown[]) => mockHasHardwareAsync(...args),
  getEnrolledLevelAsync: (...args: unknown[]) => mockGetEnrolledLevelAsync(...args),
  authenticateAsync: (...args: unknown[]) => mockAuthenticateAsync(...args),
}));

import { authenticate, enrolledSecurityLevel, isLocalUnlockAvailable } from './biometricUnlock';

describe('biometricUnlock', () => {
  beforeEach(() => {
    mockHasHardwareAsync.mockReset();
    mockGetEnrolledLevelAsync.mockReset();
    mockAuthenticateAsync.mockReset();
  });

  it('is unavailable when the OS has nothing enrolled to authenticate with', async () => {
    mockGetEnrolledLevelAsync.mockResolvedValue(0); // NONE
    expect(await isLocalUnlockAvailable()).toBe(false);

    const result = await authenticate('prompt');
    expect(result).toEqual({ outcome: 'unavailable' });
    expect(mockAuthenticateAsync).not.toHaveBeenCalled();
  });

  /**
   * A handset with a screen lock and NO biometric sensor.
   *
   * The first fix for #74 got this wrong in its own turn: it gated the level on
   * `hasHardwareAsync()`, which reports whether a face or fingerprint SCANNER
   * exists. `getEnrolledLevelAsync()` answers `SECRET` from the screen lock
   * alone, so short-circuiting to `NONE` there locked a whole class of cheap
   * Android handsets out of their own offline diary — the same conflation of "has
   * biometrics" with "can be authenticated" that #74 was about.
   */
  it('is available with a screen lock and no biometric HARDWARE at all', async () => {
    mockHasHardwareAsync.mockResolvedValue(false);
    mockGetEnrolledLevelAsync.mockResolvedValue(1); // SECRET
    mockAuthenticateAsync.mockResolvedValue({ success: true });

    expect(await isLocalUnlockAvailable()).toBe(true);
    // And it prompts, rather than reporting available and then refusing.
    expect(await authenticate('prompt')).toEqual({ outcome: 'success' });
    expect(mockAuthenticateAsync).toHaveBeenCalled();
  });

  it('is unavailable with hardware but nothing enrolled at all', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockGetEnrolledLevelAsync.mockResolvedValue(0);
    expect(await isLocalUnlockAvailable()).toBe(false);
  });

  /**
   * #74, and the whole reason this check changed.
   *
   * It used to ask `isEnrolledAsync()`, which on Android answers for BIOMETRICS
   * ONLY. A patient with a device PIN and no fingerprint therefore got `false`,
   * and `app/login.tsx` offered them nothing but "Sign in again instead" — a
   * network OIDC login — so they had no offline route into their own diary on the
   * one client that exists to work offline.
   *
   * Nothing else in the design agreed with that: `authenticateAsync` is called
   * with device fallback enabled, and `login.unlockHint` promises the passcode in
   * so many words. ADR-0015 had already rejected `disableDeviceFallback: true`
   * for this exact population.
   */
  it('is available with a device passcode and no biometric enrolled', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockGetEnrolledLevelAsync.mockResolvedValue(1); // SECRET
    mockAuthenticateAsync.mockResolvedValue({ success: true });

    expect(await isLocalUnlockAvailable()).toBe(true);
    // And it actually prompts, rather than reporting available and then refusing.
    expect(await authenticate('prompt')).toEqual({ outcome: 'success' });
    expect(mockAuthenticateAsync).toHaveBeenCalled();
  });

  it('reports the enrolled level itself, not a hardware verdict', async () => {
    // The inverse of the assertion that used to be here, which pinned a defect
    // rather than catching one: it required `NONE` whenever no scanner was
    // present, which is how a passcode-only handset lost its offline unlock.
    mockHasHardwareAsync.mockResolvedValue(false);
    mockGetEnrolledLevelAsync.mockResolvedValue(1);

    expect(await enrolledSecurityLevel()).toBe(1);
  });

  it('succeeds when the OS prompt succeeds', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockGetEnrolledLevelAsync.mockResolvedValue(3);
    mockAuthenticateAsync.mockResolvedValue({ success: true });

    const result = await authenticate('Unlock your diary');
    expect(result).toEqual({ outcome: 'success' });
    // Class 3 asserted explicitly, not incidentally. The default is
    // 'weak', which admits Android Class 2 — including 2D camera face
    // unlock, defeatable with a photograph on many implementations. That
    // would be what stands between a stranger and the patient's full
    // clinical history, so it is worth a test that fails if the option is
    // ever dropped.
    expect(mockAuthenticateAsync).toHaveBeenCalledWith({
      promptMessage: 'Unlock your diary',
      biometricsSecurityLevel: 'strong',
    });
  });

  it('reports failure without throwing when the OS prompt is cancelled', async () => {
    mockHasHardwareAsync.mockResolvedValue(true);
    mockGetEnrolledLevelAsync.mockResolvedValue(3);
    mockAuthenticateAsync.mockResolvedValue({ success: false, error: 'user_cancel' });

    const result = await authenticate('prompt');
    expect(result).toEqual({ outcome: 'failed' });
  });
});
