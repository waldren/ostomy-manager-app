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
 * The minimal async SQLite surface every migration and repository in this
 * app depends on — never `expo-sqlite`'s own `SQLiteDatabase` type
 * directly, and never `node:sqlite`'s `DatabaseSync` directly either.
 *
 * Why an interface at all, rather than importing `expo-sqlite` everywhere:
 * `expo-sqlite`'s native binding only runs on-device or in a simulator,
 * neither of which is available in this repo's CI or in the sandbox this
 * app was first built in. Depending on this interface instead of the
 * concrete module lets the exact same migration DDL and repository query
 * code run in two places — the real adapter
 * (`./expoSqliteExecutor.ts`, production) and a Node-native test adapter
 * (`../test-support/nodeSqliteExecutor.ts`, using the `node:sqlite` module
 * built into Node 22.5+) — against a *real* SQLite engine on disk in both
 * cases. See that test-support file's own header comment for exactly what
 * it does and does not prove.
 *
 * Deliberately narrow: only the four operations every repository in this
 * app actually calls. `expo-sqlite`'s `SQLiteDatabase` is a structural
 * superset of this, so the production adapter is a thin pass-through, not
 * a reimplementation.
 */
export interface SqliteExecutor {
  /** Runs one or more `;`-separated statements with no bound parameters and no result set — used for DDL. */
  execAsync(sql: string): Promise<void>;

  /** Runs one statement with bound parameters, for an INSERT/UPDATE/DELETE that returns no rows. */
  runAsync(sql: string, params?: readonly unknown[]): Promise<{ changes: number }>;

  /** Runs one SELECT and returns every matching row. */
  getAllAsync<TRow>(sql: string, params?: readonly unknown[]): Promise<TRow[]>;

  /**
   * Runs `fn` as one SQLite transaction. `fn` must use `this` executor for
   * every statement inside it — never a different executor instance,
   * never a statement issued outside the callback while it is pending.
   * This is what makes `db/offlineWrites.ts`'s "insert the entity row and
   * enqueue its sync operation" pair atomic (SRS §4.5's local-write
   * guarantee has no meaning if the two can commit independently).
   */
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;

  /** Closes the underlying connection/file handle. Production code closes only at app teardown, if ever; tests use this to simulate app termination and reopen a fresh connection against the same file. */
  closeAsync(): Promise<void>;
}
