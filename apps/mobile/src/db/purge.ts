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

import { clearDatabaseKey } from './databaseKey';
import { clearDatabaseOwner } from './databaseOwner';
import { closeDatabase } from './database';
import { DATABASE_NAME } from './expoSqliteExecutor';

/**
 * Destroys the local clinical database and the key that decrypts it.
 *
 * ## Why the file is deleted rather than the tables emptied
 *
 * `DELETE FROM observations` leaves the values in freed SQLite pages and
 * in the WAL until a `VACUUM` that may never run, so the rows remain
 * recoverable from the file with ordinary forensic tooling. For a purge
 * whose entire purpose is "this patient's data is no longer on this
 * device", leaving recoverable ciphertext-adjacent pages behind would make
 * the affordance a lie.
 *
 * Deleting the SQLCipher key alongside the file is what makes any copy
 * that escaped earlier — an OS backup snapshot taken before the purge, for
 * instance — undecryptable from this point on.
 *
 * ## Ordering is load-bearing
 *
 * Close, then delete the file, then drop the key, then drop the owner
 * record. Dropping the key while the file survives leaves a database that
 * the next `getOrCreateDatabaseKey` generates a fresh, non-matching key
 * for, and SQLCipher reports that as a generic "file is not a database"
 * with nothing naming the real cause — an app that will not start and a
 * diagnostic that points nowhere.
 */
export async function purgeLocalDatabase(): Promise<void> {
  await closeDatabase();
  await SQLite.deleteDatabaseAsync(DATABASE_NAME);
  await clearDatabaseKey();
  await clearDatabaseOwner();
}
