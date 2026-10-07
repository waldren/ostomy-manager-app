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

  /**
   * The assertion that would have caught #116, and the reason the two tests
   * either side of it could not.
   *
   * They mock `authenticateAsync` to resolve `{ success: true }` and then assert
   * that `authenticate()` succeeds — which asserts that a mock returns what it
   * was told to return. The question actually at issue is whether the OS would
   * accept a **passcode** given the options this app passes, and a mocked
   * resolution answers that by assumption.
   *
   * On a device it did not. `expo-local-authentication` documents
   * `disableDeviceFallback` as defaulting to `false` and its Kotlin record
   * declares that default, but omitting the option reached the native layer as
   * `true`: the OS was asked for `authenticators: 15` (`BIOMETRIC_STRONG` alone)
   * rather than `32783` (`| DEVICE_CREDENTIAL`), so a patient with a passcode and
   * no usable biometric could not unlock their own diary — the configuration
   * ADR-0015 (amended at #74) calls supported.
   *
   * Asserting the OPTIONS rather than the outcome is what makes this testable at
   * all without a device: the options are the app's half of the contract, and
   * they are what regressed.
   */
  it('asks the OS to accept the device passcode, not biometrics alone', async () => {
    mockGetEnrolledLevelAsync.mockResolvedValue(1); // SECRET
    mockAuthenticateAsync.mockResolvedValue({ success: true });

    await authenticate('prompt');

    expect(mockAuthenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ disableDeviceFallback: false }),
    );
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
    /**
     * Both options, and the exact match is deliberate — but note what it cost
     * (#116).
     *
     * Class 3 is asserted explicitly, not incidentally: the default is `'weak'`,
     * which admits Android Class 2 — including 2D camera face unlock, defeatable
     * with a photograph on many implementations. That would be what stands
     * between a stranger and the patient's full clinical history.
     *
     * The hazard is that `toHaveBeenCalledWith` against an object literal is an
     * EXACT match, so a test written to fail when an option is *dropped* also
     * fails when one is *added* — and this one did exactly that. It pinned an
     * option set with no `disableDeviceFallback`, which is the set that locked a
     * passcode-only patient out of their diary, and it would have failed the fix
     * for it. A test can hold a defect in place as firmly as it holds a
     * guarantee; the difference is only whether the pinned shape is the right
     * one, which the assertion itself cannot tell you.
     */
    expect(mockAuthenticateAsync).toHaveBeenCalledWith({
      promptMessage: 'Unlock your diary',
      biometricsSecurityLevel: 'strong',
      disableDeviceFallback: false,
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
