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

import type { SqliteExecutor } from '../executor';

/**
 * The single-row `sync_cursor` table — this device's delta-pull
 * high-water mark (`docs/sync-contract.md` §5.2, §5.3). Seeded to `'0'` by
 * `../schema.ts`'s migration 1, so this table is never empty and every
 * reader can assume exactly one row exists.
 *
 * **`docs/sync-contract.md` §3.6 / §5.3, restated as code-adjacent
 * guidance because it is the rule easiest to violate by accident:** the
 * only legitimate caller of `setCursor` is the delta pull response handler
 * (P2.S2b). A push response's `appliedServerSequence` is a receipt for
 * where one row landed, never a cursor — advancing this table from one
 * would skip every row written between the last delta pull and that push
 * batch, silently, with no way to detect it later.
 */

export async function getCursor(executor: SqliteExecutor): Promise<string> {
  const rows = await executor.getAllAsync<{ cursor: string }>(
    'SELECT cursor FROM sync_cursor WHERE id = 1;',
  );
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      'sync_cursor has no row — migration 1 should have seeded it. Did runMigrations() run against this database?',
    );
  }
  return row.cursor;
}

/** Called only from a delta-pull response handler (P2.S2b) — see this module's header comment. */
export async function setCursor(
  executor: SqliteExecutor,
  cursor: string,
  updatedAt: string,
): Promise<void> {
  await executor.runAsync('UPDATE sync_cursor SET cursor = ?, updated_at = ? WHERE id = 1;', [
    cursor,
    updatedAt,
  ]);
}
