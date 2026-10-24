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
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
} from '../entry/observationCodes';
import { deviceTimeZone, now as clockNow } from '../lib/utils/clock';

import { perfMarksEnabled, timeAsync } from './perfMarks';

const HISTORY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

let ran = false;

/**
 * The 90-day history read a history screen will make, timed once per launch
 * (P4.S5, #158; SRS §5.1's "30–90 days").
 *
 * There is no history screen yet (P5.S1), so this stands in for its read: the
 * query `listObservationsByCode` describes as "the shape a future history
 * screen needs", for each of the three codes the dashboard records, bounded to
 * the patient's last 90 local days (ADR-0016), with every row read in full
 * through SQLCipher. It returns nothing and renders nothing; only its duration
 * leaves the function.
 *
 * Runs only when the marks are on (see `perfMarks.ts`), and at most once per
 * launch, after Home is ready, so it measures a warm database the way a
 * patient opening their history would meet it.
 */
export async function runHistoryProbeOnce(executor: SqliteExecutor): Promise<void> {
  if (!perfMarksEnabled() || ran) return;
  ran = true;
  const since = toLocalDate(
    new Date(clockNow().getTime() - HISTORY_DAYS * DAY_MS),
    deviceTimeZone(),
  );
  // Caught and dropped: a sign-out purge mid-read rejects it, and this module's
  // whole job is to be inert. Nothing is logged; there is nothing useful to say.
  await timeAsync('history-90d-query', async () => {
    for (const code of [
      STOMA_OUTPUT_LOINC_CODE,
      FLUID_INTAKE_LOINC_CODE,
      VOIDED_URINE_LOINC_CODE,
    ]) {
      await executor.getAllAsync(
        'SELECT * FROM observations WHERE code = ? AND deleted_at IS NULL AND local_date >= ? ORDER BY effective_datetime DESC;',
        [code, since],
      );
    }
  }).catch(() => undefined);
}

/** Test-only. */
export function resetHistoryProbeForTests(): void {
  ran = false;
}
