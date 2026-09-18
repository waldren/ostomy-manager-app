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

import type { SqliteExecutor } from './executor';
import { setCursor } from './repositories/syncCursorRepository';

export interface StaleCursorRecoveryResult {
  /** Server-derived rows discarded, per entity table. */
  readonly discardedObservations: number;
  readonly discardedMeals: number;
  /** Rows kept because this device still owes the server an operation for them. */
  readonly keptPendingObservations: number;
  readonly keptPendingMeals: number;
}

/**
 * Performs `docs/sync-contract.md` §5.4's recovery from `CURSOR_TOO_OLD`.
 *
 * ## Why a wipe is required at all
 *
 * A tombstone is the only thing that tells this device to delete a row. Once
 * the server purges tombstones at its retention horizon (§10), a device whose
 * cursor predates that horizon will never be shown them — so it keeps clinical
 * entries the patient deleted and the server no longer holds, indefinitely and
 * invisibly. The server refusing a stale `since` is what makes that detectable;
 * this is the other half, and without it the refusal just halts the device
 * forever.
 *
 * ## What is discarded, and what is emphatically not
 *
 * §5.4 now says "discard its **server-derived** entity state", and that word
 * was added because of this function. The section's first draft said "wipe
 * local entity state", which read literally also destroys entries the patient
 * has written and this device has not yet pushed — forbidden by §9.1 in the
 * same document ("retained locally ... never dropped"), and worse under §9.5,
 * since the patient was already told those entries were saved. A re-sync from
 * zero cannot bring them back: the server has never seen them. The contract
 * governs, so the contradiction was resolved there rather than here.
 *
 * So the discard is scoped to rows this device can actually re-obtain: those with
 * **no queued, in-flight or rejected operation of their own**. Every such row
 * came from a delta page and will come again, or is exactly the row §5.4
 * exists to remove. A row the queue still references is this device's own
 * unsent work and survives; its operation pushes normally afterwards, and the
 * server resolves any conflict by §4's last-write-wins as usual.
 *
 * A `rejected` operation counts as pending on purpose. It is sitting in the
 * correction inbox waiting for the patient, and deleting the row underneath it
 * would leave an inbox entry describing an entry that no longer exists.
 *
 * ## Ordering
 *
 * The cursor reset and the deletes commit together. A cursor reset that
 * survived a failed delete would re-pull everything on top of rows that should
 * have gone, quietly restoring the state §5.4 exists to clear; a delete that
 * survived a failed cursor reset would discard rows and never re-fetch them.
 * Neither is recoverable from the device side, so neither may happen alone.
 */
export async function recoverFromStaleCursor(
  executor: SqliteExecutor,
  now: () => Date,
): Promise<StaleCursorRecoveryResult> {
  let result: StaleCursorRecoveryResult = {
    discardedObservations: 0,
    discardedMeals: 0,
    keptPendingObservations: 0,
    keptPendingMeals: 0,
  };

  await executor.withTransactionAsync(async () => {
    const keptObservations = await countPending(executor, 'Observation', 'observations');
    const keptMeals = await countPending(executor, 'Meal', 'meals');

    const discardedObservations = await discardUnreferenced(
      executor,
      'observations',
      'Observation',
    );
    const discardedMeals = await discardUnreferenced(executor, 'meals', 'Meal');

    // `since=0` is the contract's re-sync-from-scratch value, and the same
    // one a device has before its first ever pull — so the next cycle takes
    // the ordinary first-sync path rather than a special one.
    await setCursor(executor, '0', now().toISOString());

    result = {
      discardedObservations,
      discardedMeals,
      keptPendingObservations: keptObservations,
      keptPendingMeals: keptMeals,
    };
  });

  return result;
}

/**
 * Deletes rows no queue entry refers to.
 *
 * A real `DELETE`, not a tombstone: a tombstone is a statement that the
 * PATIENT deleted something, which the delta pull would then hand back to the
 * server's view of the world. This is the device admitting it cannot trust its
 * own copy, which is a different fact and must not be recorded as the first.
 */
async function discardUnreferenced(
  executor: SqliteExecutor,
  table: 'observations' | 'meals',
  entityType: 'Observation' | 'Meal',
): Promise<number> {
  const before = await countRows(executor, table);
  await executor.runAsync(
    `DELETE FROM ${table}
      WHERE id NOT IN (SELECT entity_id FROM sync_queue WHERE entity_type = ?);`,
    [entityType],
  );
  const after = await countRows(executor, table);
  return before - after;
}

async function countPending(
  executor: SqliteExecutor,
  entityType: 'Observation' | 'Meal',
  table: 'observations' | 'meals',
): Promise<number> {
  const rows = await executor.getAllAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM ${table}
      WHERE id IN (SELECT entity_id FROM sync_queue WHERE entity_type = ?);`,
    [entityType],
  );
  return rows[0]?.n ?? 0;
}

async function countRows(executor: SqliteExecutor, table: string): Promise<number> {
  const rows = await executor.getAllAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table};`);
  return rows[0]?.n ?? 0;
}
