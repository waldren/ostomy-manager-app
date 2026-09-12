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
