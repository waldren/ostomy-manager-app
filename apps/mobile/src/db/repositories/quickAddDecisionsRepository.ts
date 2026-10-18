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

import type { QuickAddDecision, QuickAddRoutine } from '@ostomy/core/sync';

import type { SqliteExecutor } from '../executor';

/**
 * The patient's Quick-Add decisions on this device (P4.S3 slice 5b,
 * `docs/sync-contract.md` §7.7). See local migration 11.
 */

/** One decision, about one routine. */
export interface LocalQuickAddDecision {
  /** The derived id (`quickAddPreferenceId`), the sync `entityId`. */
  readonly id: string;
  readonly routine: QuickAddRoutine;
  readonly decision: QuickAddDecision;
  /** When the decision was made, on whichever device. */
  readonly clientUpdatedAt: string;
}

interface DecisionRawRow {
  id: string;
  code: string;
  value_ml: string | null;
  method: string | null;
  fluid_type_code: string | null;
  urine_color_code: string | null;
  entered_measurement_system: string;
  decision: string;
  client_updated_at: string;
}

function decode(row: DecisionRawRow): LocalQuickAddDecision {
  return {
    id: row.id,
    routine: {
      code: row.code,
      valueMl: row.value_ml === null ? null : Number(row.value_ml),
      method: row.method,
      fluidTypeCode: row.fluid_type_code,
      urineColorCode: row.urine_color_code,
      // The table's CHECK constraints hold these two columns to these values.
      enteredMeasurementSystem: row.entered_measurement_system as 'metric' | 'imperial',
    },
    decision: row.decision as QuickAddDecision,
    clientUpdatedAt: row.client_updated_at,
  };
}

export async function listQuickAddDecisions(
  executor: SqliteExecutor,
): Promise<LocalQuickAddDecision[]> {
  const rows = await executor.getAllAsync<DecisionRawRow>(
    'SELECT * FROM quick_add_decisions ORDER BY client_updated_at ASC, id ASC;',
  );
  return rows.map(decode);
}

export async function getQuickAddDecision(
  executor: SqliteExecutor,
  id: string,
): Promise<LocalQuickAddDecision | undefined> {
  const rows = await executor.getAllAsync<DecisionRawRow>(
    'SELECT * FROM quick_add_decisions WHERE id = ?;',
    [id],
  );
  const row = rows[0];
  return row === undefined ? undefined : decode(row);
}

/**
 * Writes a decision, whether made here or pulled from the server — the row is
 * the same either way, because the id is.
 *
 * The routine's columns are written on insert and never changed: the id is
 * derived from them, so a different routine is a different row.
 */
export async function writeQuickAddDecision(
  executor: SqliteExecutor,
  decision: LocalQuickAddDecision,
  updatedAt: string,
): Promise<void> {
  const { routine } = decision;
  await executor.runAsync(
    `INSERT INTO quick_add_decisions (
      id, code, value_ml, method, fluid_type_code, urine_color_code,
      entered_measurement_system, decision, client_updated_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      decision = excluded.decision,
      client_updated_at = excluded.client_updated_at,
      updated_at = excluded.updated_at;`,
    [
      decision.id,
      routine.code,
      // Migration 1's rule: an exact decimal string at rest. `String()` of a
      // JSON number is its shortest exact form.
      routine.valueMl === null ? null : String(routine.valueMl),
      routine.method,
      routine.fluidTypeCode,
      routine.urineColorCode,
      routine.enteredMeasurementSystem,
      decision.decision,
      decision.clientUpdatedAt,
      updatedAt,
    ],
  );
}
