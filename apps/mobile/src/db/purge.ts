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
import { withDatabaseClosed } from './database';
import { DATABASE_NAME } from './expoSqliteExecutor';

/**
 * Destroys the local clinical database and the key that decrypts it.
 *
 * ## Why the file is deleted rather than the tables emptied
 *
 * `DELETE FROM observations` leaves the values in freed SQLite pages and in
 * the WAL until a `VACUUM` that may never run, so the rows remain
 * recoverable from the file with ordinary forensic tooling. For a purge
 * whose entire purpose is "this patient's data is no longer on this
 * device", leaving them behind would make the affordance a lie.
 *
 * Deleting the SQLCipher key alongside the file is what makes any copy that
 * escaped earlier — an OS backup snapshot taken before the purge —
 * undecryptable from this point on.
 *
 * ## Ordering, and why each step tolerates having already happened
 *
 * Close, delete the file, drop the key, drop the owner. Dropping the key
 * while the file survives leaves a database the next
 * `getOrCreateDatabaseKey` mints a fresh, non-matching key for, and
 * SQLCipher reports that as a generic "file is not a database" with nothing
 * naming the cause.
 *
 * Every step is **idempotent**, which is not cosmetic. A patient who signs
 * out and back in hits this twice: sign-out purges and clears the owner, so
 * the subsequent `completeLogin` sees `owner (null) !== subject` and purges
 * again — now against a database that does not exist. A throw there would
 * reject `completeLogin` and make it impossible to log in after signing
 * out, with only the generic sign-in error to go on.
 *
 * The same tolerance covers an interrupted purge: a run that died after
 * deleting the file leaves the key and owner behind, and re-running must
 * finish the job rather than fail on the missing file.
 */
export async function purgeLocalDatabase(): Promise<void> {
  await withDatabaseClosed(async () => {
    try {
      await SQLite.deleteDatabaseAsync(DATABASE_NAME);
    } catch {
      // Already gone. See the idempotency note above: this is the ordinary
      // sign-out-then-sign-in path, not an error.
    }
  });

  // Outside `withDatabaseClosed` because these touch the keychain, not the
  // database file, and must still run if the delete above was a no-op.
  await clearDatabaseKey();
  await clearDatabaseOwner();
}
