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

import type { SqliteExecutor } from '../db/executor';
import {
  enqueueVolumelessUrineCreate,
  enqueueVolumetricObservationCreate,
} from '../db/offlineWrites';
import { toWireInstant } from '../lib/utils/clock';

import type { QuickAddSuggestion } from './quickAddSuggestions';

/**
 * Writes the entry a Quick-Add tap stands for (P3.S4).
 *
 * Goes through the same two `enqueue…` functions the entry screens use, so the
 * local write and the `sync_queue` append stay in one transaction and this path
 * cannot drift from the forms. `offlineWrites.ts` says in as many words that it
 * is "the seam this module exists to be"; a fourth write path here would be
 * exactly the re-derivation it warns against.
 *
 * ## What is new, and what is reused
 *
 * **New:** the timestamp. A tap means "this happened now", which is the one
 * field a repeat cannot inherit — and it is why `decideQuickAdd` re-validates
 * rather than trusting that the original entry passed: `now` is a new value for
 * the Tier 1 timestamp rules to judge.
 *
 * **Reused:** everything else, verbatim from the entries the widget was
 * generated from — the canonical value, the Measured/Estimated answer, the
 * fluid type, the colour. Nothing is defaulted and nothing is derived.
 *
 * ## `enteredMeasurementSystem` is the CURRENT system, not the suggestion's
 *
 * ADR-0012 makes this field "the client's asserted entry system" — what the
 * patient entered in, which only the device knows. A tap enters nothing, so the
 * question is what the patient asserted by tapping, and the answer is the
 * system the label they tapped was rendered in: `QuickAddWidgets` converts a
 * suggestion into the current system for display, so that is what they saw and
 * chose.
 *
 * The suggestion's own `enteredMeasurementSystem` is provenance of the
 * *suggestion*, used to render it (`convertVolumeForDisplay` needs the entry
 * system to know whether a cross-system rounding applies) — not of the new row.
 * Carrying it onto the new row instead would record a patient who has since
 * switched as still entering in the old system, which is the specific mistake
 * ADR-0012 says is wrong "precisely for the patients who switched".
 *
 * Today this is a distinction without a behavioural difference:
 * `DEFAULT_MEASUREMENT_SYSTEM` is a constant until P4.S3 gives it a
 * preference, so both are `metric` and nothing exercises the choice. It is
 * written down because the reasoning is the part that will be hard to
 * reconstruct when they can differ.
 *
 * ## The canonical value is NOT re-derived from the display value
 *
 * A suggestion's `canonicalValue` is stored verbatim and written verbatim. The
 * tempting alternative — take the displayed number and convert it back — would
 * put ADR-0005's whole-unit display rounding into the saved data for any
 * patient whose current system differs from the entry's, turning 350 mL into
 * 12 oz into 354.882 mL. Display rounding must never travel inward.
 */
export async function logQuickAdd(
  executor: SqliteExecutor,
  suggestion: QuickAddSuggestion,
  enteredMeasurementSystem: MeasurementSystem,
  now: () => Date,
): Promise<{ id: string; operationId: string }> {
  const effectiveDatetime = toWireInstant(now());

  if (suggestion.kind === 'volumeless-urine') {
    return enqueueVolumelessUrineCreate(
      executor,
      {
        code: suggestion.code,
        effectiveDatetime,
        enteredMeasurementSystem,
        urineColorCode: suggestion.urineColorCode,
      },
      now,
    );
  }

  return enqueueVolumetricObservationCreate(
    executor,
    {
      code: suggestion.code,
      valueQuantityValue: suggestion.canonicalValue,
      valueQuantityUnit: 'mL',
      effectiveDatetime,
      measuredOrEstimated: suggestion.method,
      enteredMeasurementSystem,
      fluidTypeCode: suggestion.fluidTypeCode,
      urineColorCode: suggestion.urineColorCode,
    },
    now,
  );
}
