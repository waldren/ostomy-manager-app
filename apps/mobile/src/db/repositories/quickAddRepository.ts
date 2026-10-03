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

import type { MeasurementSystem } from '@ostomy/core/units';

import type { SqliteExecutor } from '../executor';

import type { QuickAddCandidate } from '../../quickadd/quickAddSuggestions';

interface CandidateRawRow {
  readonly code: string;
  readonly value_quantity_value: string | null;
  readonly method: string | null;
  readonly fluid_type_code: string | null;
  readonly urine_color_code: string | null;
  readonly entered_measurement_system: string;
  readonly occurrences: number;
  readonly last_entered_at: string;
}

/**
 * Recent repeated entries, grouped by everything the patient asserted
 * (P3.S4, SRS §3.1).
 *
 * ## Why the grouping is in SQL and the ranking is not
 *
 * `GROUP BY` and `COUNT(*)` are what a database is for, and the alternative —
 * reading a fortnight of rows into JavaScript and grouping there — would make
 * the dashboard's cost grow with the patient's diary. The *ranking*, the
 * minimum-occurrence floor and the cap live in
 * `../../quickadd/quickAddSuggestions.ts` instead, because those are the rules
 * worth testing as functions, and a `LIMIT 3` here would hide them inside a
 * string.
 *
 * ## Tombstones and unsent rows
 *
 * `deleted_at IS NULL` excludes entries the patient has deleted: a deleted
 * entry is not part of a routine, and offering it back as one tap would be the
 * app arguing with them.
 *
 * Unsent rows are deliberately **included**. The local store is the source of
 * truth for what this patient has entered (`docs/sync-contract.md`), so a
 * patient who logs the same drink three times on a plane should see the widget
 * before the queue drains — anything else would make the dashboard depend on
 * connectivity, which §5.1 specifically rules out for this feature.
 *
 * ## Why `effective_datetime` and not `created_at`
 *
 * The window is about when the entry *happened*, which is what a routine is
 * made of. A patient catching up on three days of entries at once has
 * `created_at` clustered in one evening, and bounding on it would show the
 * whole backfill as the current routine.
 */
export async function listQuickAddCandidates(
  executor: SqliteExecutor,
  options: {
    readonly codes: readonly string[];
    /** Wire instant; rows at or after this are considered. */
    readonly since: string;
  },
): Promise<QuickAddCandidate[]> {
  if (options.codes.length === 0) return [];

  // Parameterised, including the IN list — a code is a literal in this app
  // today, but a query built by concatenation stops being safe the moment one
  // comes from anywhere else.
  const placeholders = options.codes.map(() => '?').join(', ');
  const rows = await executor.getAllAsync<CandidateRawRow>(
    `SELECT code,
            value_quantity_value,
            method,
            fluid_type_code,
            urine_color_code,
            entered_measurement_system,
            COUNT(*) AS occurrences,
            MAX(effective_datetime) AS last_entered_at
       FROM observations
      WHERE deleted_at IS NULL
        AND effective_datetime >= ?
        AND code IN (${placeholders})
      GROUP BY code,
               value_quantity_value,
               method,
               fluid_type_code,
               urine_color_code,
               entered_measurement_system
      ORDER BY occurrences DESC, last_entered_at DESC;`,
    [options.since, ...options.codes],
  );

  return rows.map((row) => ({
    code: row.code,
    valueQuantityValue: row.value_quantity_value,
    method: row.method,
    fluidTypeCode: row.fluid_type_code,
    urineColorCode: row.urine_color_code,
    // Narrowed rather than validated: `../schema.ts` constrains the column to
    // these two with a CHECK, and ADR-0012 makes it NOT NULL with no default,
    // so there is no third value to handle and inventing a fallback would hide
    // a schema break rather than survive one.
    enteredMeasurementSystem: row.entered_measurement_system as MeasurementSystem,
    occurrences: row.occurrences,
    lastEnteredAt: row.last_entered_at,
  }));
}
