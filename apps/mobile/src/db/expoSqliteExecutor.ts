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

import { getOrCreateDatabaseKey } from './databaseKey';

import type { SqliteExecutor } from './executor';

/**
 * The one production database file this app opens. A named, on-disk
 * database, deliberately not `:memory:` — SQLite's on-disk file is exactly
 * the mechanism "survives app restart and OS background termination"
 * relies on, with no extra persistence step this app has to implement:
 * `expo-sqlite` writes it under the app's sandboxed documents directory,
 * which iOS/Android preserve across both an ordinary relaunch and the OS
 * killing the app in the background.
 */
export const DATABASE_NAME = 'ostomy-diary.db';

/**
 * Opens (creating if absent) the on-device SQLite database and adapts it
 * to `SqliteExecutor`. `expo-sqlite`'s `SQLiteDatabase` already implements
 * every method this interface needs with a compatible signature — this is
 * a pass-through, not a reimplementation, so a change to `expo-sqlite`'s
 * own async API surface fails here loudly (a type error) rather than
 * silently.
 */
export async function openExpoSqliteExecutor(
  databaseName: string = DATABASE_NAME,
): Promise<SqliteExecutor> {
  const db = await SQLite.openDatabaseAsync(databaseName);

  // SQLCipher. This PRAGMA must be the FIRST statement executed on the
  // connection — before the WAL pragma below and before any query — or
  // SQLCipher treats the file as plaintext and every later statement fails
  // with a generic "file is not a database". See `databaseKey.ts` for why
  // the store is encrypted and where the key lives (ADR-0014).
  await db.execAsync(`PRAGMA key = '${await getOrCreateDatabaseKey()}';`);

  // PROVE the key took effect. This is the one assertion that separates
  // "encrypted" from "the pragma was silently ignored".
  //
  // Stock SQLite accepts an unknown `PRAGMA key` and does NOTHING — no
  // error, no warning. So a build without SQLCipher (Expo Go, a dev client
  // predating `useSQLCipher: true`, or that option dropped in a future
  // app.json edit) writes every observation and every `sync_queue.payload`
  // in plaintext, and every test still passes. The opposite failure is
  // already loud: a WRONG key makes the next statement raise "file is not a
  // database". Only this direction is silent, and it is the direction that
  // leaks PHI.
  const cipherRows = await db.getAllAsync<{ cipher_version?: string }>('PRAGMA cipher_version;');
  if (!cipherRows[0]?.cipher_version) {
    throw new Error(
      'SQLCipher is not active: PRAGMA cipher_version returned nothing, so the local ' +
        'clinical database would be written in plaintext (ADR-0014). Check useSQLCipher ' +
        'in app.json, and note this app cannot run under Expo Go.',
    );
  }

  // ON OS BACKUP, and what is and is not solved here.
  //
  // Android is handled declaratively: `allowBackup: false` in app.json
  // keeps the file out of Google Auto Backup entirely.
  //
  // iOS has no manifest equivalent, and `expo-file-system@57` REMOVED
  // `setIsExcludedFromBackupAsync` (verified: the symbol exists nowhere in
  // the installed package), so the file cannot be marked excluded from JS
  // at this version. The database therefore still enters iCloud/iTunes
  // backup on iOS.
  //
  // What makes that acceptable rather than a hole is the pair of controls
  // above and in `databaseKey.ts`: the backed-up file is SQLCipher
  // ciphertext, and its key is held with
  // `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, which the keychain does NOT
  // migrate to a new device on restore. So a backup restored onto someone
  // else's phone yields an undecryptable file, while a restore onto the
  // same device still works — which is the behaviour a patient wants.
  //
  // The exclusion attribute remains worth adding as defence in depth (it
  // would stop the ciphertext leaving the device at all, rather than
  // relying on key separation) and needs an Expo config plugin with a
  // native mod. Tracked as a follow-up, not silently skipped.

  // WAL journal mode: readers (a screen listing history) do not block a
  // concurrent writer (a queued sync-worker write), and it is the mode
  // expo-sqlite itself recommends for anything beyond a trivial database.
  // Foreign keys are off by default in SQLite and this schema has none yet
  // (P2.S2a is Observation + sync_queue only — no patient/profile table
  // locally), so there is nothing to turn on; recorded here so the first
  // migration that adds a local foreign key does not have to rediscover
  // that this pragma is still unset.
  await db.execAsync('PRAGMA journal_mode = WAL;');

  return {
    execAsync: (sql) => db.execAsync(sql),
    runAsync: async (sql, params = []) => {
      const result = await db.runAsync(sql, params as SQLite.SQLiteBindParams);
      return { changes: result.changes };
    },
    getAllAsync: <TRow>(sql: string, params: readonly unknown[] = []) =>
      db.getAllAsync<TRow>(sql, params as SQLite.SQLiteBindParams),
    withTransactionAsync: (fn) => db.withTransactionAsync(fn),
    closeAsync: () => db.closeAsync(),
  };
}
