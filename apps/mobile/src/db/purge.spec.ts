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

import * as SQLite from 'expo-sqlite';

import { getDatabase, getDatabaseGeneration, resetDatabaseForTests } from './database';
import { purgeLocalDatabase } from './purge';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  deleteDatabaseAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(async () => 'deadbeef'),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('./migrations', () => ({ runMigrations: jest.fn(async () => undefined) }));

const mockOpen = SQLite.openDatabaseAsync as jest.Mock;
const mockDelete = SQLite.deleteDatabaseAsync as jest.Mock;

function fakeDatabase() {
  return {
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ changes: 0 })),
    // The SQLCipher probe reads this; a non-empty cipher_version means active.
    getAllAsync: jest.fn(async () => [{ cipher_version: '4.5.0' }]),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  resetDatabaseForTests();
  mockOpen.mockImplementation(async () => fakeDatabase());
});

describe('purgeLocalDatabase', () => {
  it('closes the connection before deleting the file', async () => {
    // Deleting out from under a live handle is how the module ended up
    // serving a dead executor for the rest of the process.
    const db = fakeDatabase();
    mockOpen.mockImplementationOnce(async () => db);
    await getDatabase();

    await purgeLocalDatabase();

    expect(db.closeAsync).toHaveBeenCalled();
    expect(db.closeAsync.mock.invocationCallOrder[0]).toBeLessThan(
      mockDelete.mock.invocationCallOrder[0]!,
    );
  });

  it('bumps the generation so consumers know their executor is dead', async () => {
    await getDatabase();
    const before = getDatabaseGeneration();

    await purgeLocalDatabase();

    expect(getDatabaseGeneration()).toBeGreaterThan(before);
  });

  it('tolerates a database that is already gone', async () => {
    /**
     * The ordinary sign-out-then-sign-in path, not an error. Sign-out
     * purges and clears the owner, so the next `completeLogin` sees
     * `owner (null) !== subject` and purges AGAIN — now against a file that
     * does not exist. A throw here rejected `completeLogin`, which meant
     * NO PATIENT COULD LOG IN AFTER SIGNING OUT, with only the generic
     * sign-in error to go on.
     */
    mockDelete.mockRejectedValueOnce(new Error('no such database'));

    await expect(purgeLocalDatabase()).resolves.toBeUndefined();
  });

  it('is safe to run twice in a row', async () => {
    await getDatabase();
    await purgeLocalDatabase();
    await expect(purgeLocalDatabase()).resolves.toBeUndefined();
  });

  it('clears the key and the owner even when the file was already gone', async () => {
    // An interrupted purge leaves the key and owner behind. Re-running must
    // finish the job rather than fail on the missing file — otherwise the
    // next open mints a fresh, non-matching key and SQLCipher reports only
    // "file is not a database".
    const SecureStore = jest.requireMock('expo-secure-store');
    mockDelete.mockRejectedValueOnce(new Error('no such database'));

    await purgeLocalDatabase();

    const deletedKeys = SecureStore.deleteItemAsync.mock.calls.map((call: unknown[]) => call[0]);
    expect(deletedKeys).toEqual(
      expect.arrayContaining(['ostomy.db.key', 'ostomy.db.ownerSubject']),
    );
  });

  it('opens a fresh connection on the next getDatabase, never the closed one', async () => {
    const first = fakeDatabase();
    mockOpen.mockImplementationOnce(async () => first);
    const before = await getDatabase();

    await purgeLocalDatabase();
    const after = await getDatabase();

    expect(after).not.toBe(before);
  });

  it('holds off a concurrent getDatabase rather than racing the delete', async () => {
    // Without this, a caller that asked mid-purge opened a brand-new
    // connection to the file about to be deleted. Lethal once a background
    // sync worker runs alongside sign-out: the worker would hold a
    // pre-purge handle and could push one patient's queued rows under
    // another patient's token.
    await getDatabase();

    const purge = purgeLocalDatabase();
    const concurrent = getDatabase();
    await Promise.all([purge, concurrent]);

    // The delete happened before the re-open that the concurrent call
    // resolved with.
    const reopenOrder = mockOpen.mock.invocationCallOrder.at(-1)!;
    expect(mockDelete.mock.invocationCallOrder[0]).toBeLessThan(reopenOrder);
  });

  it('leaves no key behind for a file a concurrent caller re-created', async () => {
    /**
     * The key-clear window, and the ONLY test of the pair that can detect
     * it. Its sibling asserted an ordering bounded by
     * `reopen === calls[0] ? Infinity : reopen` — and in a scenario with
     * one open, `reopen` IS `calls[0]`, so the bound was literally
     * Infinity. It passed against the exact mutation its own comment
     * described, and has been deleted.
     *
     * A second actor is what makes the window observable: with the clears
     * outside `withDatabaseClosed` the sequence becomes
     * open, delete, open, clearKey — a key deleted after the file it
     * encrypts was recreated, leaving a database nobody can open.
     */
    const SecureStore = jest.requireMock('expo-secure-store');
    await getDatabase();

    const purge = purgeLocalDatabase();
    const concurrent = getDatabase();
    await Promise.all([purge, concurrent]);

    const keyClearOrder = SecureStore.deleteItemAsync.mock.invocationCallOrder[0]!;
    const reopenOrder = mockOpen.mock.invocationCallOrder.at(-1)!;
    expect(keyClearOrder).toBeLessThan(reopenOrder);
  });
});
