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
 * The local `meals` table (P3.S1, SRS AC 2.4) — the first app-native synced
 * entity on this device.
 *
 * Mirrors `observationsRepository` deliberately: the same write-then-enqueue
 * discipline, the same tombstone-never-delete rule, the same
 * `markServerSequence` stamp. A meal that behaved differently locally from an
 * observation would make the sync contract mean two things on one device.
 */

/** AC 2.4 AC2's relative scale, in the wire's lowercase spelling — the local store follows the wire rather than inventing a second vocabulary. */
export const MEAL_SIZES = ['small', 'medium', 'large'] as const;
export type MealSize = (typeof MEAL_SIZES)[number];

export interface LocalMeal {
  readonly id: string;
  readonly description: string | null;
  readonly size: MealSize;
  readonly tagCodes: readonly string[];
  readonly effectiveDatetime: string;
  readonly enteredTimezone: string;
  /** `YYYY-MM-DD` in that zone. Not monotonic with `effectiveDatetime` (ADR-0016). */
  readonly localDate: string;
  readonly clientUpdatedAt: string;
  readonly serverSequence: string | null;
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface MealRawRow {
  id: string;
  description: string | null;
  size: string;
  tag_codes: string;
  effective_datetime: string;
  entered_timezone: string;
  local_date: string;
  client_updated_at: string;
  server_sequence: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export function decodeMealRow(row: MealRawRow): LocalMeal {
  return {
    id: row.id,
    description: row.description,
    size: decodeSize(row.size),
    tagCodes: decodeTagCodes(row.tag_codes),
    effectiveDatetime: row.effective_datetime,
    enteredTimezone: row.entered_timezone,
    localDate: row.local_date,
    clientUpdatedAt: row.client_updated_at,
    serverSequence: row.server_sequence,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The schema's CHECK constraint already restricts this column — this
 * decode-boundary guard is what lets `LocalMeal.size` be the real union rather
 * than a bare `string`, following the same "decode, don't cast" discipline
 * `types.ts` uses for the measurement system.
 */
function decodeSize(value: string): MealSize {
  if ((MEAL_SIZES as readonly string[]).includes(value)) return value as MealSize;
  throw new TypeError(
    'meals.size held a value outside the schema CHECK constraint (the database file is likely corrupt or was written by an incompatible schema version).',
  );
}

/**
 * Tags round-trip through JSON because SQLite has no array type.
 *
 * A row whose JSON does not parse decodes as NO tags rather than throwing.
 * The tags are an optional annotation on an entry whose clinical content is
 * the description, the size and the time — losing them degrades the row, while
 * throwing would make the whole meal unreadable and take the screen down with
 * it. Nothing is logged: the value is patient content (CLAUDE.md).
 */
function decodeTagCodes(raw: string): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((code): code is string => typeof code === 'string');
  } catch {
    return [];
  }
}

export interface NewLocalMeal {
  readonly id: string;
  readonly description: string | null;
  readonly size: MealSize;
  readonly tagCodes: readonly string[];
  readonly effectiveDatetime: string;
  readonly enteredTimezone: string;
  readonly localDate: string;
  readonly clientUpdatedAt: string;
}

/**
 * Inserts a new local meal. Callers wanting the write-then-enqueue transaction
 * — the actual offline-first save path — use `../offlineWrites.ts`, which
 * calls this and `enqueueOperation` inside one `withTransactionAsync`. Never
 * call this alone from a screen.
 */
export async function insertMeal(
  executor: SqliteExecutor,
  fields: NewLocalMeal,
  now: string,
): Promise<void> {
  await executor.runAsync(
    `INSERT INTO meals (
      id, description, size, tag_codes, effective_datetime, entered_timezone,
      local_date, client_updated_at, server_sequence, deleted_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?);`,
    [
      fields.id,
      fields.description,
      fields.size,
      JSON.stringify([...fields.tagCodes]),
      fields.effectiveDatetime,
      fields.enteredTimezone,
      fields.localDate,
      fields.clientUpdatedAt,
      now,
      now,
    ],
  );
}

/** Full replacement of an existing meal's fields — `docs/sync-contract.md` §4: "an update is a full replacement of the entity's fields, not a patch". */
export async function replaceMeal(
  executor: SqliteExecutor,
  fields: NewLocalMeal,
  now: string,
): Promise<void> {
  await executor.runAsync(
    `UPDATE meals SET
      description = ?, size = ?, tag_codes = ?, effective_datetime = ?,
      entered_timezone = ?, local_date = ?, client_updated_at = ?,
      deleted_at = NULL, updated_at = ?
     WHERE id = ?;`,
    [
      fields.description,
      fields.size,
      JSON.stringify([...fields.tagCodes]),
      fields.effectiveDatetime,
      fields.enteredTimezone,
      fields.localDate,
      fields.clientUpdatedAt,
      now,
      fields.id,
    ],
  );
  // `deleted_at = NULL` is the resurrection §4 requires: an update at T2 beats
  // a delete at T1. Without it a locally tombstoned meal would stay hidden
  // even after the server said it is alive again.
}

/** Tombstones a meal in place (§1: "Deletes never remove rows"). */
export async function tombstoneMeal(
  executor: SqliteExecutor,
  id: string,
  deletedAt: string,
  clientUpdatedAt: string,
  now: string,
): Promise<void> {
  await executor.runAsync(
    `UPDATE meals SET deleted_at = ?, client_updated_at = ?, updated_at = ? WHERE id = ?;`,
    [deletedAt, clientUpdatedAt, now, id],
  );
}

export async function getMealById(
  executor: SqliteExecutor,
  id: string,
): Promise<LocalMeal | undefined> {
  const rows = await executor.getAllAsync<MealRawRow>('SELECT * FROM meals WHERE id = ?;', [id]);
  return rows[0] === undefined ? undefined : decodeMealRow(rows[0]);
}

/** A day's meals, most recent first, excluding tombstones unless a caller explicitly asks. */
export async function listMealsByLocalDate(
  executor: SqliteExecutor,
  localDate: string,
  options: { includeDeleted?: boolean } = {},
): Promise<LocalMeal[]> {
  const rows = options.includeDeleted
    ? await executor.getAllAsync<MealRawRow>(
        'SELECT * FROM meals WHERE local_date = ? ORDER BY effective_datetime DESC;',
        [localDate],
      )
    : await executor.getAllAsync<MealRawRow>(
        'SELECT * FROM meals WHERE local_date = ? AND deleted_at IS NULL ORDER BY effective_datetime DESC;',
        [localDate],
      );
  return rows.map(decodeMealRow);
}

/** Stamps the server-assigned sequence once a push receipt or delta row confirms it (§3.6). */
export async function markMealServerSequence(
  executor: SqliteExecutor,
  id: string,
  serverSequence: string,
): Promise<void> {
  await executor.runAsync('UPDATE meals SET server_sequence = ? WHERE id = ?;', [
    serverSequence,
    id,
  ]);
}
