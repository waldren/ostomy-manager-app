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

/**
 * React Native's HTTP cache held PHI in plain text until the API sent
 * `no-store` (#152). jest has no file system for this module, so these pin
 * which directory is removed and that a failure never escapes; whether
 * OkHttp's cache really lives there is HW-12's to confirm on a device.
 */

import { clearHttpCache, HTTP_CACHE_DIRECTORY_NAME } from './httpCache';

const mockDirectories: { readonly parts: unknown[]; exists: boolean; delete: jest.Mock }[] = [];
let mockExists = true;
let mockDeleteError: Error | undefined;

jest.mock('expo-file-system', () => ({
  Paths: { cache: 'CACHE_DIRECTORY' },
  Directory: jest.fn().mockImplementation((...parts: unknown[]) => {
    const directory = {
      parts,
      exists: mockExists,
      delete: jest.fn(() => {
        if (mockDeleteError !== undefined) throw mockDeleteError;
      }),
    };
    mockDirectories.push(directory);
    return directory;
  }),
}));

beforeEach(() => {
  mockDirectories.length = 0;
  mockExists = true;
  mockDeleteError = undefined;
});

describe('clearHttpCache', () => {
  it('deletes React Native’s HTTP cache directory inside the app cache', () => {
    clearHttpCache();

    expect(mockDirectories).toHaveLength(1);
    expect(mockDirectories[0]?.parts).toEqual(['CACHE_DIRECTORY', 'http-cache']);
    expect(mockDirectories[0]?.delete).toHaveBeenCalledTimes(1);
    expect(HTTP_CACHE_DIRECTORY_NAME).toBe('http-cache');
  });

  it('does nothing when there is no cache, as after the first launch', () => {
    mockExists = false;

    clearHttpCache();

    expect(mockDirectories[0]?.delete).not.toHaveBeenCalled();
  });

  /** It runs on sign-out and at startup; a failed delete must stop neither. */
  it('never throws', () => {
    mockDeleteError = new Error('busy');

    expect(() => clearHttpCache()).not.toThrow();
  });
});
