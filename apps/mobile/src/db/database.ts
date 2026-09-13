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
 * Bumped whenever the open connection is invalidated.
 *
 * `DatabaseProvider` holds a resolved executor in React state. Without a
 * signal it can observe, a purge closed and deleted the file out from under
 * it and the provider went on handing every screen a dead handle for the
 * rest of the process — which happened on the FIRST LOGIN OF EVERY INSTALL,
 * because a fresh database has no owner and `completeLogin` purges on the
 * mismatch. Today that costs a swallowed count; once the entry screen
 * saves through this, it costs the patient their entries.
 */
let generation = 0;

/** A purge in progress. `getDatabase()` waits on it rather than racing it. */
let purging: Promise<void> | undefined;

export function getDatabaseGeneration(): number {
  return generation;
}

/**
 * The one place production code opens the local database. Idempotent
 * within a process — a second call while the first is still opening
 * returns the same in-flight promise rather than opening the file twice.
 *
 * Applies every pending migration before resolving, so by the time this
 * promise resolves the schema is up to date and safe to read or write.
 *
 * A rejection is NOT cached. `openPromise ??= openAndMigrate()` retained a
 * rejected promise, so one transient failure — a keychain unavailable
 * before first device unlock, a migration error — poisoned every later call
 * for the process lifetime and presented as a database that silently never
 * arrives.
 */
export async function getDatabase(): Promise<SqliteExecutor> {
  // Never hand back a handle to a file that is being deleted.
  if (purging) {
    await purging;
  }
  if (!openPromise) {
    openPromise = openAndMigrate();
    openPromise.catch(() => {
      openPromise = undefined;
    });
  }
  return openPromise;
}

async function openAndMigrate(): Promise<SqliteExecutor> {
  const executor = await openExpoSqliteExecutor();
  await runMigrations(executor, systemNow);
  return executor;
}

/**
 * Runs `work` with no database open, holding off any concurrent
 * `getDatabase()` for its duration, and invalidates every outstanding
 * executor afterwards.
 *
 * The close-then-delete ordering used to be written out at the call site,
 * which left two gaps: `closeDatabase()` cleared `openPromise` BEFORE
 * awaiting the close, so a concurrent `getDatabase()` opened a fresh
 * connection to the file about to be deleted; and nothing told consumers
 * their executor was dead. Both are lethal once a sync worker runs
 * alongside sign-out — the worker would hold a pre-purge handle and could
 * push one patient's queued rows under another patient's token, the exact
 * audit-attribution defect `databaseOwner.ts` exists to prevent.
 */
export async function withDatabaseClosed(work: () => Promise<void>): Promise<void> {
  const run = (async () => {
    const pending = openPromise;
    openPromise = undefined;
    if (pending) {
      try {
        await (await pending).closeAsync();
      } catch {
        // Already closed, or never finished opening. Either way the goal —
        // no live handle on the file about to be touched — is met.
      }
    }
    await work();
    // Last, so a consumer re-reading on the bump cannot open mid-work.
    generation += 1;
  })();

  purging = run.then(
    () => undefined,
    () => undefined,
  );
  try {
    await run;
  } finally {
    purging = undefined;
  }
}

/** Test-only: forces the next `getDatabase()` call to open a fresh connection. Production code never calls this. */
export function resetDatabaseForTests(): void {
  openPromise = undefined;
  purging = undefined;
  generation = 0;
}
