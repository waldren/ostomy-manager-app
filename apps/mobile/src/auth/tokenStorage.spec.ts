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

// An in-memory stand-in for the OS keychain/keystore `expo-secure-store`
// wraps — enough to prove this module's own logic (key name, "has a
// token" derivation) without a real device.
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  getItemAsync: jest.fn((key: string) => Promise.resolve(mockStore.get(key) ?? null)),
  setItemAsync: jest.fn((key: string, value: string) => {
    mockStore.set(key, value);
    return Promise.resolve();
  }),
  deleteItemAsync: jest.fn((key: string) => {
    mockStore.delete(key);
    return Promise.resolve();
  }),
}));

import {
  clearRefreshToken,
  getRefreshToken,
  hasStoredRefreshToken,
  setRefreshToken,
} from './tokenStorage';

describe('tokenStorage', () => {
  beforeEach(() => {
    mockStore.clear();
  });

  it('reports no mockStored token before one is ever set', async () => {
    expect(await hasStoredRefreshToken()).toBe(false);
    expect(await getRefreshToken()).toBeNull();
  });

  it('round-trips a mockStored refresh token', async () => {
    await setRefreshToken('a-refresh-token');
    expect(await hasStoredRefreshToken()).toBe(true);
    expect(await getRefreshToken()).toBe('a-refresh-token');
  });

  it('clears the mockStored token on sign-out', async () => {
    await setRefreshToken('a-refresh-token');
    await clearRefreshToken();
    expect(await hasStoredRefreshToken()).toBe(false);
  });
});
