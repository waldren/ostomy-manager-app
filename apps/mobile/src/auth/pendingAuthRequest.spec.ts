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
  clearPendingAuthRequest,
  getPendingAuthRequest,
  setPendingAuthRequest,
} from './pendingAuthRequest';

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
  setItemAsync: jest.fn(),
  getItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

const mockStore = SecureStore as jest.Mocked<typeof SecureStore>;

const REQUEST = {
  codeVerifier: 'verifier-abc',
  state: 'state-xyz',
  redirectUri: 'ostomydiary://redirect',
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('the pending authorization request (ADR-0021)', () => {
  /**
   * The load-bearing assertion of this file.
   *
   * ADR-0015 puts the refresh token behind `requireAuthentication`, and
   * reaching for the same options here would deadlock sign-in: this value is
   * read in the MIDDLE of establishing a session, when there is no enrolled
   * identity to authenticate against. A biometric prompt at that moment gates
   * sign-in on the thing sign-in exists to create.
   *
   * Asserted rather than commented, because "same as the refresh token" is the
   * obvious and wrong instinct for the next person to touch this.
   */
  it('is NOT stored behind a biometric gate, unlike the refresh token', async () => {
    await setPendingAuthRequest(REQUEST);

    const options = mockStore.setItemAsync.mock.calls[0]?.[2];
    expect(options).toBeDefined();
    expect(options?.requireAuthentication).toBeUndefined();
    // Still device-only and still not readable before first unlock: the
    // narrowing is to the biometric gate alone, not to keychain accessibility.
    expect(options?.keychainAccessible).toBe(SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY);
  });

  it('round-trips the three values the completer cannot work without', async () => {
    await setPendingAuthRequest(REQUEST);
    const stored = mockStore.setItemAsync.mock.calls[0]?.[1] as string;
    mockStore.getItemAsync.mockResolvedValue(stored);

    await expect(getPendingAuthRequest()).resolves.toEqual(REQUEST);
  });

  it('is absent when nothing is in flight', async () => {
    mockStore.getItemAsync.mockResolvedValue(null);

    await expect(getPendingAuthRequest()).resolves.toBeUndefined();
  });

  /**
   * A corrupt entry must read as "no usable request in flight", never throw.
   *
   * The caller is an effect inside a route render; an unhandled rejection there
   * is a crash on the screen a patient reaches mid-sign-in. The failure path
   * for "no pending request" already exists and is correct for this case.
   */
  describe('an unusable stored value reads as absent rather than throwing', () => {
    it('handles text that is not JSON', async () => {
      mockStore.getItemAsync.mockResolvedValue('not json at all');

      await expect(getPendingAuthRequest()).resolves.toBeUndefined();
    });

    it('handles JSON that is not an object', async () => {
      mockStore.getItemAsync.mockResolvedValue('"a string"');

      await expect(getPendingAuthRequest()).resolves.toBeUndefined();
    });

    it('handles null, which parses but has no fields', async () => {
      mockStore.getItemAsync.mockResolvedValue('null');

      await expect(getPendingAuthRequest()).resolves.toBeUndefined();
    });

    /**
     * A partial object is the dangerous one: it would otherwise yield a request
     * with `state: undefined`, and a `state` that cannot be compared is a
     * `state` check that passes by accident.
     */
    it.each(['codeVerifier', 'state', 'redirectUri'] as const)(
      'handles a stored object missing %s',
      async (field) => {
        const partial: Record<string, unknown> = { ...REQUEST };
        delete partial[field];
        mockStore.getItemAsync.mockResolvedValue(JSON.stringify(partial));

        await expect(getPendingAuthRequest()).resolves.toBeUndefined();
      },
    );
  });

  it('deletes under the same key and options it wrote', async () => {
    await setPendingAuthRequest(REQUEST);
    await clearPendingAuthRequest();

    const writtenKey = mockStore.setItemAsync.mock.calls[0]?.[0];
    const deletedKey = mockStore.deleteItemAsync.mock.calls[0]?.[0];
    // Not pedantry: `expo-secure-store` resolves an entry by key AND options,
    // so a delete with mismatched options silently leaves the secret in place.
    expect(deletedKey).toBe(writtenKey);
    expect(mockStore.deleteItemAsync.mock.calls[0]?.[1]).toEqual(
      mockStore.setItemAsync.mock.calls[0]?.[2],
    );
  });
});
