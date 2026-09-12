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

import { DatabaseSync } from 'node:sqlite';

import type { SqliteExecutor } from '../db/executor';

/**
 * A test-only `SqliteExecutor` backed by Node's built-in `node:sqlite`
 * module (stable enough for this use since Node 22.5, still flagged
 * experimental by Node itself as of this writing), used **only** by tests
 * under `src/db/**\/*.spec.ts` and never imported by production code
 * (`app/`, or anything `src/db/database.ts` reaches).
 *
 * **Why this exists at all.** `expo-sqlite`'s real implementation only
 * runs inside the Expo/React Native native runtime — on a device, in a
 * simulator, or under Expo Go — none of which exist in this repo's CI or
 * in the sandboxed environment this app was first built in. `jest-expo`
 * auto-mocks `expo-sqlite`'s native module, so a test that imports it
 * directly exercises a mock, not SQL. Rather than assert our own DDL is
 * correct by reading it, this executor runs the *exact same*
 * `src/db/schema.ts` DDL and the *exact same* repository query strings
 * against a *real* SQLite engine, on a real file on disk.
 *
 * **What this proves.** That the schema in `src/db/schema.ts` is valid
 * SQLite, that `src/db/migrations.ts`'s version-tracking logic behaves
 * correctly against a real engine, that the repository queries in
 * `src/db/repositories/**` round-trip data correctly, and — the specific
 * claim P2.S2a's exit criteria requires demonstrating — that data written
 * in one connection to a **named, on-disk** database file is still present
 * after that connection is closed and a brand-new connection opens the
 * same file path. That close-then-reopen cycle is the mechanism by which
 * SQLite persistence across "app restart" and "OS background termination"
 * holds in the first place: the file, not any particular open handle, is
 * what survives, and `expo-sqlite` and `node:sqlite` are both, at bottom,
 * bindings to the same on-disk file format.
 *
 * **What this does NOT prove**, and must not be cited as proving: that
 * `expo-sqlite`'s specific native binding behaves identically to
 * `node:sqlite`'s; that iOS/Android actually preserve this app's sandboxed
 * documents directory across a real OS background kill (an OS-level
 * guarantee this repo is relying on, not implementing); or anything about
 * Metro bundling, the Expo config plugin, or the native module linking
 * `apps/mobile/app.json`'s `expo-sqlite` plugin entry configures. Those
 * require a device or simulator, which P2.S2a's environment does not have
 * available — see `apps/mobile/README.md`.
 */
export function createNodeSqliteExecutor(filePath: string): SqliteExecutor {
  const db = new DatabaseSync(filePath);

  return {
    execAsync: async (sql) => {
      db.exec(sql);
    },
    runAsync: async (sql, params = []) => {
      const statement = db.prepare(sql);
      const result = statement.run(...(params as (string | number | bigint | null)[]));
      return { changes: Number(result.changes) };
    },
    getAllAsync: async <TRow>(sql: string, params: readonly unknown[] = []) => {
      const statement = db.prepare(sql);
      return statement.all(...(params as (string | number | bigint | null)[])) as TRow[];
    },
    withTransactionAsync: async (fn) => {
      db.exec('BEGIN;');
      try {
        await fn();
        db.exec('COMMIT;');
      } catch (error) {
        db.exec('ROLLBACK;');
        throw error;
      }
    },
    closeAsync: async () => {
      db.close();
    },
  };
}
