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
 * The check behind the Add Urine screen (SRS §3.7, AC 12.1).
 *
 * A urine entry is the only one in this app that may record NO AMOUNT: a
 * patient who cannot measure may save a colour alone (AC 12.1 AC2). So
 * which rules apply depends on what they actually entered, and this module
 * makes that choice once rather than leaving the screen to reason about it.
 *
 * ## Which engine, and why the screen does not decide
 *
 * With an amount, `validateVolumetricEntry` — identical treatment to stoma
 * output and intake, including the mandatory Measured/Estimated toggle
 * (AC 12.1 AC1). Without one, `validateVolumelessObservation`, which keeps
 * the timestamp rules and drops every rule that presupposes a number.
 *
 * Both live in `@ostomy/core/validation`. This module picks between them;
 * it does not re-implement or skip any rule, because CLAUDE.md requires the
 * two tiers defined once there and composed the same way by every caller.
 *
 * ## "An amount or a colour" is a UX affordance here, not a rule
 *
 * An entry carrying neither records nothing, and the server refuses it
 * (`PAYLOAD_FIELD_INVALID` naming `urineColorCode`). This screen simply
 * does not offer Save until one is present, which is what CLAUDE.md means
 * by client-side validation being "a UX affordance only" — the
 * authoritative rule is the server's, re-enforced on every synced
 * operation, and duplicating it here as a Tier 1 rule would invent a
 * clinical rule in a screen.
 */

import type { MeasurementSystem } from '@ostomy/core/units';
import {
  ESTIMATION_METHOD_CODE,
  isBlocked,
  validateVolumelessObservation,
  validateVolumetricEntry,
  type MeasuredOrEstimated,
  type VolumetricValidationThresholds,
} from '@ostomy/core/validation';

import { toCanonicalMl, type EntryCheck } from './useStomaOutputEntry';

/**
 * Re-exported so the Add Urine screen imports its result type from the module
 * whose function returns it. The shape is `checkEntry`'s, unchanged and
 * deliberately shared: both screens render the same four outcomes, and a
 * separate-but-identical union would be two things to keep in step.
 */
export type { EntryCheck };

/**
 * The field a urine rejection names.
 *
 * `valueQuantity.value` when there is an amount — the same field the other
 * volumetric screens use — and the colour when there is not, because that
 * is the only input the patient can act on.
 */
export const VOIDED_URINE_VALUE_FIELD = 'valueQuantity.value';
export const VOIDED_URINE_COLOR_FIELD = 'urineColorCode';

export interface UrineDraft {
  /** Empty when the patient is recording a colour instead of an amount. */
  readonly amountText: string;
  readonly method: MeasuredOrEstimated | undefined;
  /** A `urine_color` member code, or undefined when none was chosen. */
  readonly urineColorCode: string | undefined;
  readonly effectiveDateTime: Date;
}

export interface UrineCheckInput {
  readonly draft: UrineDraft;
  readonly measurementSystem: MeasurementSystem;
  readonly thresholds: VolumetricValidationThresholds;
  readonly surgeryDate: Date | null;
  readonly now: Date;
}

/** Whether the patient has entered enough for the entry to record anything at all. */
export function hasSomethingToRecord(draft: UrineDraft): boolean {
  return draft.amountText.trim().length > 0 || draft.urineColorCode !== undefined;
}

/**
 * Runs the right engine over a urine draft and says what the screen should
 * do next. Order matches `checkEntry`'s: Tier 1, then D4, then Tier 2.
 */
export function checkUrineEntry(input: UrineCheckInput): EntryCheck {
  const recordingAnAmount = input.draft.amountText.trim().length > 0;

  const result = recordingAnAmount
    ? validateVolumetricEntry(
        {
          field: VOIDED_URINE_VALUE_FIELD,
          // Canonical mL before validation, ALWAYS (ADR-0004) — the
          // thresholds are canonical-mL bounds, so an imperial number
          // compared against them silently never warns.
          rawValueMl: toCanonicalMl(input.draft.amountText, input.measurementSystem),
          method: input.draft.method ?? null,
          effectiveDateTime: input.draft.effectiveDateTime,
          surgeryDate: input.surgeryDate,
          now: input.now,
        },
        input.thresholds,
      )
    : validateVolumelessObservation(
        {
          field: VOIDED_URINE_COLOR_FIELD,
          // No amount means no Measured/Estimated selection to carry, and
          // core rejects one that is present (METHOD_NOT_APPLICABLE). The
          // screen hides the toggle in this state, so reaching that
          // rejection means something else went wrong — which is exactly
          // when a rule is worth having.
          method: input.draft.method ?? null,
          effectiveDateTime: input.draft.effectiveDateTime,
          surgeryDate: input.surgeryDate,
          now: input.now,
        },
        input.thresholds,
      );

  if (isBlocked(result) && result.tier1.outcome === 'blocked') {
    return { kind: 'blocked', errors: result.tier1.errors };
  }

  // D4's shape, unchanged: an Estimated entry is perfectly good and the
  // software cannot store it yet. Only reachable when an amount was
  // entered, because the toggle does not apply without one.
  if (input.draft.method === 'estimated' && !ESTIMATION_METHOD_CODE.resolved) {
    return { kind: 'estimated-unavailable' };
  }

  if (result.tier2.outcome === 'warn') {
    return { kind: 'needs-confirmation', warnings: result.tier2.warnings };
  }

  return { kind: 'ready' };
}
