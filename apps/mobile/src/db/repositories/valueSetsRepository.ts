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
 * The device's cached copy of the admin-managed value sets
 * (`GET /api/v1/value-sets`).
 *
 * Exists because two requirements meet, exactly as they do for the threshold
 * cache: value-set members are configuration and never a hardcoded list
 * (CLAUDE.md — members are retired, never deleted, so a retired one must stop
 * being offered while still resolving in history), and this app renders entry
 * screens **offline**, where nothing can be fetched.
 *
 * **There is no default and no fallback.** A default here would be a hardcoded
 * value set wearing a database costume, and — worse — it would be silently
 * stale rather than absent, so an admin who retired a member would have no way
 * to discover a fielded app was still offering it. `readValueSet` returns an
 * empty list until a fetch has succeeded, and a screen is expected to say it
 * has nothing to offer rather than invent options.
 */

export interface CachedValueSetMember {
  readonly code: string;
  readonly sortOrder: number;
  /** The member's quantity, when it has one — a container size's canonical mL (AC 2.3 AC2). `null` for a category. */
  readonly numericValue: number | null;
  readonly numericUnit: string | null;
}

interface ValueSetMemberRawRow {
  code: string;
  sort_order: number;
  numeric_value: string | null;
  numeric_unit: string | null;
}

/** Members of one set, already in the admin-chosen display order. */
export async function readValueSet(
  executor: SqliteExecutor,
  valueSetKey: string,
): Promise<readonly CachedValueSetMember[]> {
  const rows = await executor.getAllAsync<ValueSetMemberRawRow>(
    `SELECT code, sort_order, numeric_value, numeric_unit
     FROM value_set_members_cache
     WHERE value_set_key = ?
     ORDER BY sort_order ASC, code ASC;`,
    [valueSetKey],
  );

  return rows.map((row) => ({
    code: row.code,
    sortOrder: row.sort_order,
    // A member whose quantity does not parse is treated as having none rather
    // than as zero. `Number('')` is 0, and a 0 mL quick-select button would
    // fill the volume field with a value Tier 1 then blocks — a control that
    // looks usable and cannot be used.
    numericValue: toFiniteNumber(row.numeric_value),
    numericUnit: row.numeric_unit,
  }));
}

function toFiniteNumber(raw: string | null): number | null {
  if (raw === null || raw.length === 0) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ValueSetToCache {
  readonly key: string;
  readonly members: readonly CachedValueSetMember[];
}

/**
 * Replaces the cached copy of every set in one transaction.
 *
 * **Delete-then-insert per set, not an upsert.** An upsert would leave behind
 * a member the server has since RETIRED — it is simply absent from the
 * response rather than marked — so the screen would keep offering it forever
 * with nothing detecting the drift. Replacing the set is what makes a
 * retirement take effect.
 *
 * Scoped to the sets actually returned, not a blanket wipe: a response that
 * omits a set this app does not yet use must not empty a set it does.
 *
 * One transaction across all of them, so a failure mid-refresh cannot leave
 * the device with one set updated and another stale — a combination no screen
 * is written to expect.
 */
export async function writeValueSets(
  executor: SqliteExecutor,
  sets: readonly ValueSetToCache[],
  fetchedAt: string,
): Promise<void> {
  await executor.withTransactionAsync(async () => {
    for (const set of sets) {
      await executor.runAsync('DELETE FROM value_set_members_cache WHERE value_set_key = ?;', [
        set.key,
      ]);

      for (const member of set.members) {
        await executor.runAsync(
          `INSERT INTO value_set_members_cache
             (value_set_key, code, sort_order, numeric_value, numeric_unit, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?);`,
          [
            set.key,
            member.code,
            member.sortOrder,
            member.numericValue === null ? null : String(member.numericValue),
            member.numericUnit,
            fetchedAt,
          ],
        );
      }
    }
  });
}

/** The set keys this release renders. Named here so a screen imports a constant rather than repeating a string. */
export const VALUE_SET_KEY = {
  FLUID_TYPE: 'fluid_type',
  CONTAINER_SIZE: 'container_size',
  MEAL_TAG: 'meal_tag',
} as const;
