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

import { toLocalDate } from '@ostomy/core/units';

import type { SqliteExecutor } from '../db/executor';
import {
  getMealById,
  insertMeal,
  markMealServerSequence,
  replaceMeal,
  tombstoneMeal,
  MEAL_SIZES,
  type MealSize,
} from '../db/repositories/mealsRepository';
import { getObservationById } from '../db/repositories/observationsRepository';
import { setCursor } from '../db/repositories/syncCursorRepository';

import type { DecodedDeltaChange, DecodedDeltaPage } from './responseDecoding';

/**
 * Applying a `docs/sync-contract.md` §5 delta page to local state.
 *
 * Two rules govern this module and they are the ones easiest to violate by
 * accident:
 *
 * 1. **The cursor comes from a delta response and nowhere else** (§3.6,
 *    §9.4). A push receipt's `appliedServerSequence` reports where one row
 *    landed; a cursor asserts that *every* row up to that point has been
 *    seen (§5.3). Advancing from a receipt skips every row written between
 *    the last delta pull and that batch — silently, permanently, with no
 *    error on either side.
 *
 * 2. **The cursor is persisted after each page is applied**, never before
 *    and never once at the end of a multi-page pull. Persisting it first
 *    means a crash mid-apply leaves a cursor asserting rows were seen that
 *    were not, which is the same silent invisibility §5.3 exists to
 *    prevent; persisting only at the end means a 4-page pull that dies on
 *    page 3 re-downloads all four.
 */

/** What one delta pull produced. Counts only — never an entity's content (§6.3). */
export interface DeltaOutcome {
  readonly upserts: number;
  readonly tombstones: number;
  readonly pages: number;
  /** Changes skipped because a locally queued edit is newer (§4's last-write-wins, applied on the client). */
  readonly skippedAsStale: number;
  /** Changes the response shaped in a way §5.2 does not define. Skipped rather than guessed at; see `responseDecoding.ts`. */
  readonly undecodable: number;
  /** Changes for an entity type this build does not handle yet (§8). Skipped, cursor still advanced — see `DecodedDeltaChange`. */
  readonly unsupportedEntity: number;
}

/**
 * Applies one page of changes and advances the cursor to that page's
 * `cursor`, in one transaction per change plus the cursor write.
 *
 * `hasMore` is the caller's business — `runDeltaPull` loops on it. This
 * function deliberately handles exactly one page so that the "persist after
 * each page" rule above is structural rather than a thing the loop has to
 * remember.
 */
export async function applyDeltaPage(
  executor: SqliteExecutor,
  page: DecodedDeltaPage,
  appliedAt: string,
): Promise<Omit<DeltaOutcome, 'pages'>> {
  let upserts = 0;
  let tombstones = 0;
  let skippedAsStale = 0;
  let undecodable = 0;
  let unsupportedEntity = 0;

  for (const change of page.changes) {
    if (change.kind === 'undecodable') {
      undecodable += 1;
      continue;
    }
    if (change.kind === 'unsupported-entity') {
      // §8: tolerate and skip. The cursor still advances below — withholding
      // it would stall every later change behind one this build cannot use.
      unsupportedEntity += 1;
      continue;
    }
    const applied = await applyChange(executor, change, appliedAt);
    if (!applied) {
      skippedAsStale += 1;
      continue;
    }
    if (change.kind === 'tombstone') tombstones += 1;
    else upserts += 1;
  }

  // AFTER every change in the page is committed. See this module's header.
  await setCursor(executor, page.cursor, appliedAt);

  return { upserts, tombstones, skippedAsStale, undecodable, unsupportedEntity };
}

/**
 * Writes one change, unless this device holds a strictly newer version.
 *
 * ## Why the client resolves a conflict at all
 *
 * §4 makes the *server* the authority on last-write-wins, and it is. But a
 * delta page is a snapshot of what the server held when the query ran, and
 * this device may have written an entry since — one that is still sitting
 * in `sync_queue` waiting to be pushed. Applying the server's older version
 * over it would discard a local entry the patient has already been told was
 * saved (§9.5: the local write IS the confirmation), and the queued
 * operation would then push that same discarded value back up, resurrecting
 * it one round-trip later. The patient sees their entry vanish and
 * reappear.
 *
 * So the comparison here is the same one §4 specifies, on the same field:
 * the incoming `clientUpdatedAt` against the stored row's. Incoming newer
 * or equal wins, matching §4's table exactly — equal resolves in favour of
 * the incoming version there, and doing the opposite here would make the
 * two sides disagree about a tie.
 *
 * The comparison is lexical on the §7.3 wire form, for the reason
 * `batching.ts` gives: fixed-width RFC 3339 sorts chronologically as a
 * string, and `Date` parsing introduces a `NaN` state where every
 * comparison is `false`.
 */
async function applyChange(
  executor: SqliteExecutor,
  change: Extract<
    DecodedDeltaChange,
    { kind: 'upsert' } | { kind: 'tombstone' } | { kind: 'meal-upsert' }
  >,
  appliedAt: string,
): Promise<boolean> {
  if (change.kind === 'meal-upsert') {
    return applyMealUpsert(executor, change, appliedAt);
  }

  if (change.kind === 'tombstone' && change.entityType === 'Meal') {
    return applyMealTombstone(executor, change, appliedAt);
  }

  const existing = await getObservationById(executor, change.entityId);

  if (existing !== undefined && change.clientUpdatedAt < existing.clientUpdatedAt) {
    return false;
  }

  if (change.kind === 'tombstone') {
    // §5.2: a tombstone carries no payload, deliberately — the audit store
    // holds what was deleted (§4.1). So this writes the tombstone and
    // leaves the row's clinical columns exactly as they were rather than
    // blanking them: nothing on the wire could repopulate them, and a row
    // whose values were cleared is indistinguishable from one that was
    // written empty.
    await executor.runAsync(
      `UPDATE observations SET deleted_at = ?, client_updated_at = ?, server_sequence = ?, updated_at = ?
       WHERE id = ?;`,
      [appliedAt, change.clientUpdatedAt, change.serverSequence, appliedAt, change.entityId],
    );
    return true;
  }

  const payload = change.payload;
  // Derived locally from the SAME shared helper the server derives it from
  // (ADR-0016) — `localDate` is deliberately absent from the wire (§7.2),
  // because a transmitted one would be a second source of truth for a pure
  // function of two fields already in the payload.
  const localDate = toLocalDate(new Date(payload.effectiveDateTime), payload.enteredTimezone);

  // An upsert, because a delta page is equally the initial sync of a fresh
  // install (`since=0`, §5.1) and an update to a row this device already
  // holds. `INSERT OR REPLACE` would be wrong — it deletes and re-inserts,
  // discarding `created_at` and every column this statement does not name.
  if (existing === undefined) {
    await executor.runAsync(
      `INSERT INTO observations (
        id, resource_type, code, value_quantity_value, value_quantity_unit,
        urine_color_code, effective_datetime, method, status,
        entered_measurement_system, entered_timezone, local_date,
        client_updated_at, server_sequence, deleted_at, created_at, updated_at
      ) VALUES (?, 'Observation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?);`,
      [
        payload.id,
        payload.code,
        // §7.3's JSON number becomes this column's exact decimal string.
        // `String()` on a JSON-parsed number is its shortest round-tripping
        // form, which is the value itself for every DECIMAL(12,4) the
        // server can hold.
        //
        // ABSENT stays absent: a colour-only voided-urine row (AC 12.1 AC2)
        // carries no `valueQuantity`, and `String(undefined)` would persist
        // the literal text "undefined" as a clinical value. NULL is what the
        // column means by "this entry recorded no amount".
        payload.valueQuantity === undefined ? null : String(payload.valueQuantity.value),
        payload.valueQuantity?.unit ?? null,
        payload.urineColorCode ?? null,
        payload.effectiveDateTime,
        payload.method,
        payload.status,
        payload.enteredMeasurementSystem,
        payload.enteredTimezone,
        localDate,
        change.clientUpdatedAt,
        change.serverSequence,
        appliedAt,
        appliedAt,
      ],
    );
    return true;
  }

  await executor.runAsync(
    `UPDATE observations SET
      code = ?, value_quantity_value = ?, value_quantity_unit = ?,
      urine_color_code = ?,
      effective_datetime = ?, method = ?, status = ?,
      entered_measurement_system = ?, entered_timezone = ?, local_date = ?,
      client_updated_at = ?, server_sequence = ?, deleted_at = NULL, updated_at = ?
     WHERE id = ?;`,
    [
      payload.code,
      // See the insert above: absent stays absent, never "undefined".
      payload.valueQuantity === undefined ? null : String(payload.valueQuantity.value),
      payload.valueQuantity?.unit ?? null,
      payload.urineColorCode ?? null,
      payload.effectiveDateTime,
      payload.method,
      payload.status,
      payload.enteredMeasurementSystem,
      payload.enteredTimezone,
      localDate,
      change.clientUpdatedAt,
      change.serverSequence,
      appliedAt,
      payload.id,
    ],
  );
  // `deleted_at = NULL` above is the resurrection §4 requires: "an update
  // at T2 beats a delete at T1, resurrecting the row by clearing
  // deletedAt". Without it a row this device tombstoned locally would stay
  // hidden forever even after the server told it the entry is alive again.
  return true;
}

/**
 * Writes one meal change, unless this device holds a strictly newer version.
 *
 * The same last-write-wins comparison the observation path makes, on the same
 * field, for the same reason: a delta page is a snapshot of what the server
 * held when the query ran, and this device may have logged a meal since that
 * is still waiting to push. Applying the server's older version over it would
 * make an entry the patient was already told was saved (§9.5) change under
 * them and change back one cycle later.
 */
async function applyMealUpsert(
  executor: SqliteExecutor,
  change: Extract<DecodedDeltaChange, { kind: 'meal-upsert' }>,
  appliedAt: string,
): Promise<boolean> {
  const existing = await getMealById(executor, change.entityId);
  if (existing !== undefined && change.clientUpdatedAt < existing.clientUpdatedAt) {
    return false;
  }

  const size = toLocalMealSize(change.payload.size);
  // A size outside the three-step scale is not writable: the column's CHECK
  // constraint would refuse it, and guessing one would record a clinical
  // judgement the patient never made (AC 2.4 AC2).
  if (size === undefined) return false;

  const localDate = toLocalDate(
    new Date(change.payload.effectiveDateTime),
    change.payload.enteredTimezone,
  );

  const fields = {
    id: change.entityId,
    description: change.payload.description,
    size,
    tagCodes: change.payload.tagCodes,
    effectiveDatetime: change.payload.effectiveDateTime,
    enteredTimezone: change.payload.enteredTimezone,
    // Derived locally from the SAME shared helper the server derives it from
    // (ADR-0016) — `localDate` is absent from the wire on purpose.
    localDate,
    clientUpdatedAt: change.clientUpdatedAt,
  };

  if (existing === undefined) {
    await insertMeal(executor, fields, appliedAt);
  } else {
    // `replaceMeal` also clears `deleted_at`, which is the resurrection §4
    // requires when an update beats a delete.
    await replaceMeal(executor, fields, appliedAt);
  }

  await markMealServerSequence(executor, change.entityId, change.serverSequence);
  return true;
}

/** §5.2: a tombstone carries no payload, so the row's clinical values are left exactly as they were — nothing on the wire could repopulate them. */
async function applyMealTombstone(
  executor: SqliteExecutor,
  change: Extract<DecodedDeltaChange, { kind: 'tombstone' }>,
  appliedAt: string,
): Promise<boolean> {
  const existing = await getMealById(executor, change.entityId);
  if (existing !== undefined && change.clientUpdatedAt < existing.clientUpdatedAt) {
    return false;
  }
  // A tombstone for a meal this device never saw is a no-op rather than an
  // error: the row is already absent, which is the state the tombstone asks
  // for. `UPDATE` matching zero rows is exactly that.
  if (existing === undefined) return true;

  await tombstoneMeal(executor, change.entityId, appliedAt, change.clientUpdatedAt, appliedAt);
  await markMealServerSequence(executor, change.entityId, change.serverSequence);
  return true;
}

function toLocalMealSize(raw: string): MealSize | undefined {
  return (MEAL_SIZES as readonly string[]).includes(raw) ? (raw as MealSize) : undefined;
}
