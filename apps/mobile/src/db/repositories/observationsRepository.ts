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
import { decodeObservationRow, type LocalObservation, type ObservationRawRow } from '../types';

/** The fields a caller supplies when writing a new local observation row — never `createdAt`/`updatedAt` (local bookkeeping, stamped here) or `serverSequence` (unknown until sync sees a receipt). */
export interface NewLocalObservation {
  readonly id: string;
  readonly code: string;
  /** `null` only on a colour-only voided-urine entry (AC 12.1 AC2). NOT "0" — a missing amount is not a void of zero, and the schema CHECK refuses a row carrying neither an amount nor a colour. */
  readonly valueQuantityValue: string | null;
  readonly valueQuantityUnit: LocalObservation['valueQuantityUnit'] | null;
  readonly effectiveDatetime: string;
  readonly method: string | null;
  readonly status: string;
  readonly enteredMeasurementSystem: LocalObservation['enteredMeasurementSystem'];
  /** IANA zone read from the device at entry (ADR-0016). */
  readonly enteredTimezone: string;
  /** `YYYY-MM-DD` in that zone. Derived from the same shared helper the server uses, so the two cannot group a day differently. */
  readonly localDate: string;
  /** The optional fluid categorisation (SRS AC 2.3 AC1). `null` on any code that has no use for one — the server rejects a categorisation sent with such a code. */
  readonly fluidTypeCode: string | null;
  /** A `urine_color` member code on a voided-urine entry (AC 12.1 AC2); `null` on every other code, which the server rejects a colour for. */
  readonly urineColorCode: string | null;
  readonly clientUpdatedAt: string;
}

/**
 * Inserts a brand-new local observation row. Callers wanting the
 * write-then-enqueue transaction (the actual offline-first save path) use
 * `../offlineWrites.ts`'s `enqueueObservationCreate`, which calls this
 * function and `syncQueueRepository.enqueueOperation` inside one
 * `withTransactionAsync` — never call this function alone from a screen.
 */
export async function insertObservation(
  executor: SqliteExecutor,
  fields: NewLocalObservation,
  now: string,
): Promise<void> {
  await executor.runAsync(
    `INSERT INTO observations (
      id, resource_type, code, value_quantity_value, value_quantity_unit,
      urine_color_code, effective_datetime, method, status,
      entered_measurement_system, entered_timezone, local_date, fluid_type_code,
      client_updated_at, server_sequence, deleted_at, created_at, updated_at
    ) VALUES (?, 'Observation', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?);`,
    [
      fields.id,
      fields.code,
      fields.valueQuantityValue,
      fields.valueQuantityUnit,
      fields.urineColorCode,
      fields.effectiveDatetime,
      fields.method,
      fields.status,
      fields.enteredMeasurementSystem,
      fields.enteredTimezone,
      fields.localDate,
      fields.fluidTypeCode,
      fields.clientUpdatedAt,
      now,
      now,
    ],
  );
}

/**
 * Full replacement of an existing row's clinical fields — mirrors
 * `docs/sync-contract.md` §4's "an update is a full replacement of the
 * entity's fields, not a patch." Used for a local edit before it has
 * synced; a row a delta pull overwrites goes through the same function
 * once P2.S2b's pull worker exists.
 */
export async function replaceObservation(
  executor: SqliteExecutor,
  fields: NewLocalObservation,
  now: string,
): Promise<void> {
  await executor.runAsync(
    `UPDATE observations SET
      code = ?, value_quantity_value = ?, value_quantity_unit = ?,
      effective_datetime = ?, method = ?, status = ?,
      entered_measurement_system = ?, fluid_type_code = ?, urine_color_code = ?,
      client_updated_at = ?, updated_at = ?
    WHERE id = ?;`,
    [
      fields.code,
      fields.valueQuantityValue,
      fields.valueQuantityUnit,
      fields.effectiveDatetime,
      fields.method,
      fields.status,
      fields.enteredMeasurementSystem,
      fields.fluidTypeCode,
      // A full replacement writes EVERY clinical column, including this one.
      // Left out of the SET list, a correction to a voided-urine entry would
      // keep the old colour while replacing everything around it — a row
      // that is a blend of two versions, which §4's "an update is a full
      // replacement, not a patch" exists to make impossible.
      fields.urineColorCode,
      fields.clientUpdatedAt,
      now,
      fields.id,
    ],
  );
}

/** Tombstones a row in place (`docs/sync-contract.md` §1: "Deletes never remove rows"). `clientUpdatedAt` is the delete operation's own client timestamp, used later for last-write-wins against a concurrent edit (§4). */
export async function tombstoneObservation(
  executor: SqliteExecutor,
  id: string,
  deletedAt: string,
  clientUpdatedAt: string,
  now: string,
): Promise<void> {
  await executor.runAsync(
    `UPDATE observations SET deleted_at = ?, client_updated_at = ?, updated_at = ? WHERE id = ?;`,
    [deletedAt, clientUpdatedAt, now, id],
  );
}

export async function getObservationById(
  executor: SqliteExecutor,
  id: string,
): Promise<LocalObservation | undefined> {
  const rows = await executor.getAllAsync<ObservationRawRow>(
    'SELECT * FROM observations WHERE id = ?;',
    [id],
  );
  return rows[0] === undefined ? undefined : decodeObservationRow(rows[0]);
}

/**
 * History for one LOINC code, most recent first, excluding tombstones by
 * default — the shape a future history/dashboard screen needs. Includes
 * tombstones only when a caller explicitly asks (e.g. a future audit or
 * "recently deleted" view), never by accident.
 */
export async function listObservationsByCode(
  executor: SqliteExecutor,
  code: string,
  options: { includeDeleted?: boolean } = {},
): Promise<LocalObservation[]> {
  const rows = options.includeDeleted
    ? await executor.getAllAsync<ObservationRawRow>(
        'SELECT * FROM observations WHERE code = ? ORDER BY effective_datetime DESC;',
        [code],
      )
    : await executor.getAllAsync<ObservationRawRow>(
        'SELECT * FROM observations WHERE code = ? AND deleted_at IS NULL ORDER BY effective_datetime DESC;',
        [code],
      );
  return rows.map(decodeObservationRow);
}

/** Stamps the server-assigned sequence once a push receipt or delta row confirms it — P2.S2b's sync worker calls this; nothing in P2.S2a does yet. */
export async function markServerSequence(
  executor: SqliteExecutor,
  id: string,
  serverSequence: string,
): Promise<void> {
  await executor.runAsync('UPDATE observations SET server_sequence = ? WHERE id = ?;', [
    serverSequence,
    id,
  ]);
}
