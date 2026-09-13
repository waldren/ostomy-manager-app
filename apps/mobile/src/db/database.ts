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

import { now as systemNow } from '../lib/utils/clock';

import { openExpoSqliteExecutor } from './expoSqliteExecutor';
import { runMigrations } from './migrations';
import type { SqliteExecutor } from './executor';

let openPromise: Promise<SqliteExecutor> | undefined;

/**
 * The one place production code opens the local database. Idempotent
 * within a process — a second call while the first is still opening
 * returns the same in-flight promise rather than opening the file twice —
 * so `app/_layout.tsx` can call this from a `useEffect` on every render
 * with no guard of its own.
 *
 * Applies every pending migration before resolving, so a caller never has
 * to remember to call `runMigrations` separately: by the time this
 * promise resolves, the schema is fully up to date and safe to read from
 * or write to immediately.
 */
export function getDatabase(): Promise<SqliteExecutor> {
  openPromise ??= openAndMigrate();
  return openPromise;
}

async function openAndMigrate(): Promise<SqliteExecutor> {
  const executor = await openExpoSqliteExecutor();
  await runMigrations(executor, systemNow);
  return executor;
}

/**
 * Closes the open connection, if any, and forgets it.
 *
 * Used by `purgeLocalDatabase`: deleting the file out from under a live
 * connection leaves the module handing every later caller an executor
 * pointing at a database that no longer exists.
 */
export async function closeDatabase(): Promise<void> {
  const pending = openPromise;
  openPromise = undefined;
  if (!pending) {
    return;
  }
  try {
    await (await pending).closeAsync();
  } catch {
    // Already closed, or never finished opening. Either way the goal —
    // no live handle on the file about to be deleted — is met.
  }
}

/** Test-only: forces the next `getDatabase()` call to open a fresh connection. Production code never calls this. */
export function resetDatabaseForTests(): void {
  openPromise = undefined;
}
