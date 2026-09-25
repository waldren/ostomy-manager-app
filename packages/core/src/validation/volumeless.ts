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

/**
 * Validation for an observation that records NO VOLUME.
 *
 * Today that is exactly one thing: a voided-urine entry carrying a colour
 * instead of an amount (SRS §3.7, AC 12.1 AC2). A patient who cannot
 * measure still produces a hydration signal, and that entry has to be
 * savable — it is the case the feature exists for, because the patients
 * least able to measure are the ones whose hydration matters most.
 *
 * ## Why this is its own entry point rather than a flag on
 * ## `validateVolumetricEntry`
 *
 * The two answer different questions. `validateVolumetricEntry` asks "is
 * this amount structurally possible, and is it plausible" — every one of
 * its value rules presupposes a number. Passing it a missing volume and
 * asking it to skip half its rules would make the caller responsible for
 * knowing WHICH rules stop applying, which is precisely the knowledge
 * CLAUDE.md requires live here and not in each app.
 *
 * A caller now picks the function that matches what the patient entered,
 * and the rule set follows from that choice rather than from a boolean it
 * had to reason about.
 *
 * ## What still applies, and what stops
 *
 * **Still applies:** both timestamp rules. An entry with no amount can
 * still claim a moment in the future or one before the surgery date, and
 * those are structurally impossible whatever the entry records. They come
 * from `evaluateEntryTimestamp` — the same function `evaluateTier1` and the
 * meal path compose — so a colour-only urine entry, a volumetric entry and
 * a meal cannot disagree about what "in the future" means.
 *
 * **Stops:** every value rule (`VALUE_NOT_NUMERIC`, `VALUE_NOT_POSITIVE`,
 * the representability bounds) and `METHOD_REQUIRED`. There is no number
 * for them to be about.
 *
 * **Added:** `METHOD_NOT_APPLICABLE`. Measured/Estimated describes how a
 * number was arrived at, so supplying one on an entry with no number is a
 * contradiction. Catching it here is what keeps it a correctable rejection:
 * the database CHECK that also forbids it would surface as a 500, and
 * `docs/sync-contract.md` §9 tells a client to re-push a 500 indefinitely,
 * so the entry would retry forever instead of reaching the correction
 * inbox.
 *
 * ## Tier 2
 *
 * Always `pass` — not `warn` with an empty list, which would be a different
 * claim: that the entry was examined and found borderline. Tier 2's only
 * rule is the high-volume soft warning, which has nothing to compare when
 * there is no volume. Returning the same result shape as
 * `validateVolumetricEntry` keeps every caller composing one shape, and the
 * type still makes a Tier 2 result structurally incapable of blocking.
 */

import { evaluateEntryTimestamp, type EntryTimestampInput } from './entryTimestamp.js';
import { TIER1_RULE_CODE } from './ruleCodes.js';
import type { VolumetricValidationThresholds } from './thresholds.js';
import type { MeasuredOrEstimated } from './tier1.js';
import type { ValidationError, VolumetricValidationResult } from './types.js';

export interface VolumelessObservationInput extends EntryTimestampInput {
  /**
   * The Measured/Estimated selection, which on a volume-less entry must be
   * absent.
   *
   * Typed as the same union a volumetric entry uses rather than `never`, so
   * a caller can pass through whatever the patient's payload carried and
   * get a rejection back — the point is to REPORT the contradiction, not to
   * make it unrepresentable at the call site and have the caller hand-roll
   * the check instead.
   */
  readonly method: MeasuredOrEstimated | null;
}

/**
 * Validate an observation that records no volume, against both tiers.
 *
 * Both tiers are evaluated independently and unconditionally, the same way
 * `validateVolumetricEntry` composes them and for the same reason.
 */
export function validateVolumelessObservation(
  input: VolumelessObservationInput,
  thresholds: VolumetricValidationThresholds,
): VolumetricValidationResult {
  const errors: ValidationError[] = [];

  if (input.method !== null) {
    errors.push({ field: input.field, ruleCode: TIER1_RULE_CODE.METHOD_NOT_APPLICABLE });
  }

  // Timestamp rules last, matching the order `docs/sync-contract.md` §6.2
  // lists them, so two implementations walk a patient through the same
  // correction sequence for the same payload.
  errors.push(...evaluateEntryTimestamp(input, thresholds));

  return {
    tier1:
      errors.length === 0
        ? { tier: 'tier1', outcome: 'pass' }
        : { tier: 'tier1', outcome: 'blocked', errors },
    // `pass`, not `warn` with an empty list. No volume means nothing for the
    // soft warning to be about, and `warn` with no warnings would be a
    // different claim — that the entry was examined and found borderline.
    // See the module comment: this is a statement, not an omission.
    tier2: { tier: 'tier2', outcome: 'pass' },
  };
}
