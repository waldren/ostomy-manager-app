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

import {
  clearRefreshToken,
  getRefreshToken,
  hasStoredRefreshToken,
  setRefreshToken,
  storedTokenIsStaleForEnrolment,
} from './tokenStorage';

/**
 * The mock preserves the OPTIONS argument, which the previous version
 * discarded.
 *
 * That mattered: this module's whole security posture lives in those
 * options, and the old suite passed whether the accessibility class was
 * device-bound or backup-migrating, and whether `requireAuthentication` was
 * set at all. It also defined `AFTER_FIRST_UNLOCK` while the module used
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, so the value under test was
 * `undefined`.
 */
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  setItemAsync: jest.fn(async () => undefined),
  getItemAsync: jest.fn(async () => null),
  deleteItemAsync: jest.fn(async () => undefined),
}));

/**
 * The enrolment level decides which option set the token is written with (#74),
 * so it has to be controllable here. Real numeric values: the module compares
 * them by ORDER, and a mock of symbolic strings would let a reversed comparison
 * pass.
 */
const mockGetEnrolledLevelAsync = jest.fn(async () => 3);
jest.mock('expo-local-authentication', () => ({
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 },
  hasHardwareAsync: jest.fn(async () => true),
  getEnrolledLevelAsync: () => mockGetEnrolledLevelAsync(),
}));

const mockSet = SecureStore.setItemAsync as jest.Mock;
const mockGet = SecureStore.getItemAsync as jest.Mock;
const mockDelete = SecureStore.deleteItemAsync as jest.Mock;

const TOKEN_KEY = 'ostomy.auth.refreshToken';
const MARKER_KEY = 'ostomy.auth.refreshTokenPresent';

const GATED = {
  keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  requireAuthentication: true,
};
const UNGATED = { keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY' };

/** Makes the marker read answer, so the read path has something to route on. */
function markerSays(protection: 'gated' | 'ungated', enrolledLevel: number): void {
  mockGet.mockImplementation(async (key: string) =>
    key === MARKER_KEY ? JSON.stringify({ protection, enrolledLevel }) : null,
  );
}

function markerWrittenBy(): { protection: string; enrolledLevel: number } {
  const call = mockSet.mock.calls.find((c) => c[0] === MARKER_KEY);
  return JSON.parse(call?.[1] as string) as { protection: string; enrolledLevel: number };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockImplementation(async () => null);
  mockGetEnrolledLevelAsync.mockResolvedValue(3);
});

describe('the refresh token is device-bound and biometrically gated', () => {
  it('writes it with requireAuthentication and a non-migrating accessibility class', async () => {
    await setRefreshToken('rt');

    expect(mockSet).toHaveBeenCalledWith(TOKEN_KEY, 'rt', {
      keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
      requireAuthentication: true,
    });
  });

  it('reads it with the SAME options it was written with', async () => {
    // Not pedantry. `expo-secure-store` looks an entry up by key AND
    // options, and a mismatch returns null rather than erroring — which
    // would present as "the patient is signed out" on every cold start,
    // with nothing to debug.
    markerSays('gated', 3);
    await getRefreshToken();

    expect(mockGet).toHaveBeenCalledWith(TOKEN_KEY, GATED);
  });

  it('is not stored with a class that migrates to another device on backup restore', async () => {
    // The plain `AFTER_FIRST_UNLOCK` variant rides an encrypted backup onto
    // a new phone, handing that phone a live bearer credential for the
    // patient's account.
    await setRefreshToken('rt');

    const options = mockSet.mock.calls.find((call) => call[0] === TOKEN_KEY)?.[2];
    expect(options.keychainAccessible).not.toBe('AFTER_FIRST_UNLOCK');
  });
});

describe('presence is answered without reading the token', () => {
  /**
   * The defect this closes, in full:
   *
   * `hasStoredRefreshToken` used to answer by reading the token, which
   * after `requireAuthentication` became a biometric-gated read. So the OS
   * auth sheet appeared at COLD START — before the app had rendered its own
   * unlock affordance, with OS default copy — and the patient then
   * authenticated a second time when they pressed Unlock. And when that
   * read rejected (cancelled sheet, biometry locked out, key invalidated),
   * the caller had no error path and the app sat on a spinner forever.
   */
  it('checks the marker, never the token', async () => {
    await hasStoredRefreshToken();

    const keysRead = mockGet.mock.calls.map((call) => call[0]);
    expect(keysRead).toContain(MARKER_KEY);
    expect(keysRead).not.toContain(TOKEN_KEY);
  });

  it('reads the marker WITHOUT requireAuthentication, so it cannot prompt', async () => {
    // The property that actually keeps the prompt off the launch path. A
    // marker read that carried the flag would reintroduce the defect while
    // every other assertion here still passed.
    await hasStoredRefreshToken();

    const options = mockGet.mock.calls.find((call) => call[0] === MARKER_KEY)?.[1];
    expect(options.requireAuthentication).toBeUndefined();
  });

  it('reports true when the marker exists and false when it does not', async () => {
    mockGet.mockResolvedValueOnce('1');
    await expect(hasStoredRefreshToken()).resolves.toBe(true);

    mockGet.mockResolvedValueOnce(null);
    await expect(hasStoredRefreshToken()).resolves.toBe(false);
  });

  it('writes the marker alongside the token, so the two cannot disagree', async () => {
    await setRefreshToken('rt');

    const keysWritten = mockSet.mock.calls.map((call) => call[0]);
    expect(keysWritten).toEqual(expect.arrayContaining([TOKEN_KEY, MARKER_KEY]));
  });

  it('clears the marker BEFORE the token', async () => {
    // Ordering matters on a partial failure. Marker gone but token present
    // routes to a full sign-in, which works. Token gone but marker present
    // routes to an unlock that can never succeed — a patient locked out of
    // an app that believes it has a session.
    await clearRefreshToken();

    // Exact sequence, not indexOf ordering: `indexOf` passes as `-1 < 0`
    // if the marker delete is removed entirely, which is precisely the
    // mutation this is supposed to catch.
    const order = mockDelete.mock.calls.map((call) => call[0]);
    expect(order).toEqual([MARKER_KEY, TOKEN_KEY, TOKEN_KEY]);
  });

  it('deletes the token under BOTH option sets', async () => {
    // The marker naming which set wrote it has just been deleted, and lookup is
    // by key AND options. Deleting under one set only would leave a live bearer
    // credential on a device the patient believes they have signed out of.
    await clearRefreshToken();

    const optionSets = mockDelete.mock.calls.filter((c) => c[0] === TOKEN_KEY).map((c) => c[1]);
    expect(optionSets).toEqual(expect.arrayContaining([GATED, UNGATED]));
  });
});

/**
 * #74. `requireAuthentication` cannot be written on a device with no Class 3
 * biometric enrolled — the keystore key it creates specifies
 * `AUTH_BIOMETRIC_STRONG`, so `setItemAsync` rejects:
 *
 * ```
 * 'ExpoSecureStore.setValueWithKeyAsync' has been rejected.
 * → Caused by: Could not Authenticate the user: No biometrics are currently enrolled
 * ```
 *
 * That came out of `AuthContext`'s `completeLogin` AFTER a successful code
 * exchange, so the patient could not sign in AT ALL — online or off — and was
 * told "We could not sign you in. Please try again.", advice that cannot work
 * however many times it is followed.
 */
describe('a device with no biometric enrolled can still store a session (#74)', () => {
  it('writes the token ungated rather than failing the sign-in', async () => {
    mockGetEnrolledLevelAsync.mockResolvedValue(1); // SECRET: a passcode, no biometric

    await expect(setRefreshToken('rt')).resolves.toBeUndefined();

    expect(mockSet).toHaveBeenCalledWith(TOKEN_KEY, 'rt', UNGATED);
  });

  it('still refuses to let it ride a backup onto another phone', async () => {
    // Dropping `requireAuthentication` must not quietly drop the other flag with
    // it. This one has nothing to do with enrolment and no excuse to change.
    mockGetEnrolledLevelAsync.mockResolvedValue(0);
    await setRefreshToken('rt');

    const options = mockSet.mock.calls.find((c) => c[0] === TOKEN_KEY)?.[2];
    expect(options.keychainAccessible).toBe('AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY');
  });

  it('records the protection mode and the enrolment level it was written at', async () => {
    mockGetEnrolledLevelAsync.mockResolvedValue(1);
    await setRefreshToken('rt');

    expect(markerWrittenBy()).toEqual({ protection: 'ungated', enrolledLevel: 1 });
  });

  it('reads an ungated token back with ungated options', async () => {
    // The failure this prevents is silent: mismatched options return null, which
    // presents as the patient being signed out of a session they still have.
    markerSays('ungated', 1);
    await getRefreshToken();

    expect(mockGet).toHaveBeenCalledWith(TOKEN_KEY, UNGATED);
  });

  it('gates it as soon as the device can, with no code path of its own', async () => {
    mockGetEnrolledLevelAsync.mockResolvedValue(3);
    await setRefreshToken('rt');

    expect(mockSet).toHaveBeenCalledWith(TOKEN_KEY, 'rt', GATED);
    expect(markerWrittenBy()).toEqual({ protection: 'gated', enrolledLevel: 3 });
  });

  /**
   * A Class 2 sensor reports an enrolment but cannot back an
   * `AUTH_BIOMETRIC_STRONG` key, so it must take the ungated path too — the
   * distinction the old `isEnrolledAsync()` check could not make.
   */
  it('treats a weak-biometric-only device as ungated', async () => {
    mockGetEnrolledLevelAsync.mockResolvedValue(2); // BIOMETRIC_WEAK
    await setRefreshToken('rt');

    expect(mockSet).toHaveBeenCalledWith(TOKEN_KEY, 'rt', UNGATED);
  });
});

/**
 * What replaces the OS invalidation an ungated entry does not get.
 *
 * ADR-0015 says an app cannot detect an enrolment change, which is true where a
 * biometric already exists. But an ungated token was stored with NONE enrolled,
 * so any enrolment RAISES the level — observable, and exactly ADR-0015's threat
 * of someone covertly adding their own biometric to the patient's phone.
 */
describe('an enrolment appearing after the fact invalidates an ungated token', () => {
  it('reports stale when the level has risen', async () => {
    markerSays('ungated', 0);
    mockGetEnrolledLevelAsync.mockResolvedValue(3);

    await expect(storedTokenIsStaleForEnrolment()).resolves.toBe(true);
  });

  it('reports fresh when the level is unchanged', async () => {
    markerSays('ungated', 1);
    mockGetEnrolledLevelAsync.mockResolvedValue(1);

    await expect(storedTokenIsStaleForEnrolment()).resolves.toBe(false);
  });

  it('reports fresh when the level has FALLEN', async () => {
    // A patient who removes their passcode has not handed anyone anything, and
    // signing them out of an offline diary on that basis would be a lockout with
    // no threat behind it.
    markerSays('ungated', 3);
    mockGetEnrolledLevelAsync.mockResolvedValue(0);

    await expect(storedTokenIsStaleForEnrolment()).resolves.toBe(false);
  });

  it('never claims a GATED token is stale, because the OS owns that one', async () => {
    // Answering true here would sign the patient out on every launch of a device
    // that is behaving correctly.
    markerSays('gated', 0);
    mockGetEnrolledLevelAsync.mockResolvedValue(3);

    await expect(storedTokenIsStaleForEnrolment()).resolves.toBe(false);
  });

  it('reports fresh when there is no token at all', async () => {
    mockGet.mockImplementation(async () => null);

    await expect(storedTokenIsStaleForEnrolment()).resolves.toBe(false);
  });
});

describe('a marker written by a build from before #74', () => {
  /**
   * Those builds wrote the literal `'1'`, and every token they wrote was gated —
   * an ungated one could not exist yet. Reading it as anything else would pick
   * the wrong options, and mismatched options return null silently, which
   * presents as a patient being signed out of a session they still have.
   */
  it('is read as a gated token rather than as no token', async () => {
    mockGet.mockImplementation(async (key: string) => (key === MARKER_KEY ? '1' : null));

    await expect(hasStoredRefreshToken()).resolves.toBe(true);
    await getRefreshToken();
    expect(mockGet).toHaveBeenCalledWith(TOKEN_KEY, GATED);
  });

  it('is not reported stale, so an in-place upgrade does not sign everyone out', async () => {
    mockGet.mockImplementation(async (key: string) => (key === MARKER_KEY ? '1' : null));
    mockGetEnrolledLevelAsync.mockResolvedValue(3);

    await expect(storedTokenIsStaleForEnrolment()).resolves.toBe(false);
  });

  it('falls back to gated for a marker this build cannot parse', async () => {
    // Either guess costs one re-login and neither can lock the patient out, so
    // the fallback is the one every earlier build actually wrote.
    mockGet.mockImplementation(async (key: string) => (key === MARKER_KEY ? '{nonsense' : null));

    await expect(hasStoredRefreshToken()).resolves.toBe(true);
    await getRefreshToken();
    expect(mockGet).toHaveBeenCalledWith(TOKEN_KEY, GATED);
  });
});
