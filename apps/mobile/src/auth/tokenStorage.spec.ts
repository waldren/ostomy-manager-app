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

const mockSet = SecureStore.setItemAsync as jest.Mock;
const mockGet = SecureStore.getItemAsync as jest.Mock;
const mockDelete = SecureStore.deleteItemAsync as jest.Mock;

const TOKEN_KEY = 'ostomy.auth.refreshToken';
const MARKER_KEY = 'ostomy.auth.refreshTokenPresent';

beforeEach(() => {
  jest.clearAllMocks();
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
    await getRefreshToken();

    expect(mockGet).toHaveBeenCalledWith(TOKEN_KEY, {
      keychainAccessible: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
      requireAuthentication: true,
    });
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

    const order = mockDelete.mock.calls.map((call) => call[0]);
    expect(order.indexOf(MARKER_KEY)).toBeLessThan(order.indexOf(TOKEN_KEY));
  });
});
