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
} from './tokenStorage';

/**
 * ## What changed here, and why most of this file is shorter than it was
 *
 * ADR-0015 Amendment 2 (#116) removed `requireAuthentication` from the refresh
 * token, and with it the gated/ungated branch, the recorded enrolment level, and
 * `storedTokenIsStaleForEnrolment`. The suites that exercised those are deleted
 * rather than adapted: they assert a decision that no longer exists, and an
 * adapted test tends to keep asserting the old shape in a new costume.
 *
 * ## The mock preserves the OPTIONS argument, and that is the point
 *
 * This module's entire security posture lives in those options. An earlier version
 * of this mock discarded them, and the suite then passed whether the accessibility
 * class was device-bound or backup-migrating, and whether `requireAuthentication`
 * was set at all.
 *
 * That is not a historical note. **#116 was a defect in exactly this shape**: the
 * app asked the OS for the wrong authenticators, every test was green, and two of
 * them actively pinned the wrong option set in place. Assert what the app asks the
 * platform for — it is the half the app controls and the half that regressed.
 */
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  setItemAsync: jest.fn(async () => undefined),
  getItemAsync: jest.fn(async () => null),
  deleteItemAsync: jest.fn(async () => undefined),
}));

const mockSet = SecureStore.setItemAsync as jest.Mock;
const mockGet = SecureStore.getItemAsync as jest.Mock;
const mockDelete = SecureStore.deleteItemAsync as jest.Mock;

const TOKEN_KEY = 'ostomy.auth.refreshToken';
const MARKER_KEY = 'ostomy.auth.refreshTokenPresent';

/** The one option set this build uses. No `requireAuthentication` — see #116. */
const OPTIONS = { keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY' };

/** What this build writes to say "a token is here and this build can read it". */
const CURRENT_MARKER = '2';

function markerReads(value: string | null): void {
  mockGet.mockImplementation(async (key: string) => (key === MARKER_KEY ? value : 'the-token'));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockImplementation(async () => null);
});

describe('the refresh token is device-bound and NOT biometrically gated', () => {
  /**
   * The direct regression test for #116, and the reason it asserts the options
   * rather than a round trip.
   *
   * `requireAuthentication` makes `expo-secure-store` raise its own prompt on
   * read, built with a negative button and no allowed authenticators — which
   * Android forbids pairing with `DEVICE_CREDENTIAL`. That prompt is biometric-only
   * by construction, so setting this flag locks out any patient who cannot present
   * a finger, which is the population ADR-0015 twice refused to exclude. It reads
   * like an obvious hardening, which is exactly why it needs a test that fails when
   * someone restores it.
   */
  it('writes it WITHOUT requireAuthentication', async () => {
    await setRefreshToken('abc');

    const call = mockSet.mock.calls.find((c) => c[0] === TOKEN_KEY);
    expect(call?.[2]).toEqual(OPTIONS);
    expect(call?.[2]).not.toHaveProperty('requireAuthentication');
  });

  /**
   * The half of the posture Amendment 2 did NOT change, asserted separately
   * because it is easy to lose while deleting its neighbours.
   *
   * Not plain `AFTER_FIRST_UNLOCK`: that variant migrates to a new device on a
   * backup restore, so an encrypted backup restored onto a second phone would hand
   * that phone a live bearer credential for the patient's account.
   */
  it('is not stored with a class that migrates to another device on backup restore', async () => {
    await setRefreshToken('abc');

    const call = mockSet.mock.calls.find((c) => c[0] === TOKEN_KEY);
    expect(call?.[2]).toMatchObject({
      keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
    });
    expect(call?.[2]).not.toMatchObject({ keychainAccessible: 'AFTER_FIRST_UNLOCK' });
  });

  it('reads it with the same options it was written with', async () => {
    markerReads(CURRENT_MARKER);

    await getRefreshToken();

    expect(mockGet).toHaveBeenCalledWith(TOKEN_KEY, OPTIONS);
  });
});

describe('presence is answered without reading the token', () => {
  it('checks the marker, never the token', async () => {
    markerReads(CURRENT_MARKER);

    await hasStoredRefreshToken();

    expect(mockGet).toHaveBeenCalledWith(MARKER_KEY, expect.anything());
    expect(mockGet).not.toHaveBeenCalledWith(TOKEN_KEY, expect.anything());
  });

  it('reports true when a marker exists and false when it does not', async () => {
    markerReads(CURRENT_MARKER);
    expect(await hasStoredRefreshToken()).toBe(true);

    mockGet.mockImplementation(async () => null);
    expect(await hasStoredRefreshToken()).toBe(false);
  });

  it('writes the token BEFORE the marker', async () => {
    // A rejected token write must not leave a marker behind: the app would then
    // believe it has a session and route to an unlock that can never succeed.
    await setRefreshToken('abc');

    const keys = mockSet.mock.calls.map((c) => c[0] as string);
    expect(keys.indexOf(TOKEN_KEY)).toBeLessThan(keys.indexOf(MARKER_KEY));
  });

  it('clears the marker BEFORE the token', async () => {
    // The reverse of the write, for the reverse reason: a marker with no token
    // routes to an unlock that can never succeed, while a token with no marker is
    // merely garbage the next sign-in overwrites.
    await clearRefreshToken();

    expect(mockDelete.mock.calls[0]?.[0]).toBe(MARKER_KEY);
  });
});

/**
 * ADR-0015 Amendment 2's "one forced re-login on upgrade".
 *
 * An entry written by an earlier build carries `requireAuthentication`, and this
 * build does not set it. On iOS the keychain query includes the accessibility
 * class, so a mismatched read misses the entry; on Android it silently resolves.
 * Either way the token behind an old marker is not something this build should
 * report as a usable session — so the marker is a version, and anything that is
 * not the current one is discarded.
 */
describe('a token written by a build that gated it (#116 migration)', () => {
  it('is not returned, whatever the old marker said', async () => {
    markerReads('1'); // the pre-#74 literal

    expect(await getRefreshToken()).toBeNull();
  });

  it('is treated the same when the marker is #74-era JSON', async () => {
    markerReads(JSON.stringify({ protection: 'gated', enrolledLevel: 3 }));

    expect(await getRefreshToken()).toBeNull();
  });

  it('clears the stale entry rather than leaving it to be found again', async () => {
    // Left on disk it would be re-read on the next call and found stale again; left
    // WITH its marker it would route the patient to an unlock that can never
    // succeed — which is #116's symptom, reintroduced by the code meant to retire
    // it.
    markerReads('1');

    await getRefreshToken();

    expect(mockDelete).toHaveBeenCalledWith(MARKER_KEY, expect.anything());
    expect(mockDelete).toHaveBeenCalledWith(TOKEN_KEY, expect.anything());
  });

  /**
   * The patient must be told, not merely signed out.
   *
   * `hasStoredRefreshToken` answers from the marker, and a stale marker still means
   * a session exists on disk — so the cold start routes to the lock screen, where
   * `unlock()` finds it stale and ends the session with a reason the login screen
   * can show. Answering `false` here would drop them on a bare sign-in screen, and
   * CLAUDE.md records what that reads as: "a patient who meets a bare sign-in
   * screen assumes their diary is gone".
   */
  it('still reports a session, so the sign-out can be explained', async () => {
    markerReads('1');

    expect(await hasStoredRefreshToken()).toBe(true);
  });
});

describe('clearing removes the token under every option set that could have written it', () => {
  it('deletes with this build options AND the gated options of older builds', async () => {
    await clearRefreshToken();

    const tokenDeletes = mockDelete.mock.calls.filter((c) => c[0] === TOKEN_KEY);
    expect(tokenDeletes).toHaveLength(2);
    expect(tokenDeletes.map((c) => c[1])).toEqual(
      expect.arrayContaining([OPTIONS, { ...OPTIONS, requireAuthentication: true }]),
    );
  });

  /**
   * One failed delete must not skip the other.
   *
   * The point of deleting twice is not leaving a live bearer credential on a device
   * the patient believes they have signed out of, and a first rejection
   * short-circuiting the second attempt would be that outcome produced by the code
   * meant to prevent it.
   */
  it('attempts both even when the first rejects', async () => {
    mockDelete.mockImplementation(
      async (key: string, options: { requireAuthentication?: true }) => {
        if (key === TOKEN_KEY && options.requireAuthentication !== true) throw new Error('nope');
      },
    );

    await clearRefreshToken();

    expect(mockDelete.mock.calls.filter((c) => c[0] === TOKEN_KEY)).toHaveLength(2);
  });

  it('rethrows only when NEITHER delete got anywhere', async () => {
    // One success means the entry is gone; a caller only needs to learn about it
    // when the token may still be there.
    mockDelete.mockImplementation(async (key: string) => {
      if (key === TOKEN_KEY) throw new Error('nope');
    });

    await expect(clearRefreshToken()).rejects.toThrow('nope');
  });
});
