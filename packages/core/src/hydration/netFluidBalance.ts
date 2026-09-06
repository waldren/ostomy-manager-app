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

import {
  BODY_WEIGHT_LOINC_CODE,
  FLUID_INTAKE_LOINC_CODE,
  RESTING_HEART_RATE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
} from './loincCodes.js';

/**
 * LOINC codes whose canonical mL values are summed into Daily Net Fluid
 * Balance: stoma output and fluid intake only. Written once and exported,
 * so every call site imports this set instead of re-deriving "which codes
 * count" from `code` string literals — the exact mistake
 * design-specs/data-model/p1-s3-schema-coverage.md's §3.7 note warns is
 * the path of least resistance given the schema's index shape.
 */
export const DAILY_NET_FLUID_BALANCE_LOINC_CODES: ReadonlySet<string> = new Set([
  STOMA_OUTPUT_LOINC_CODE,
  FLUID_INTAKE_LOINC_CODE,
]);

/**
 * Named negative space, so "voided urine is excluded from Daily Net Fluid
 * Balance" is a fact a reviewer can grep for, not an inference drawn from
 * what is merely absent from the include-set above.
 *
 * Net balance measures stoma losses; urine output independently signals
 * renal perfusion. Summing them would let a normal-looking balance hide a
 * dangerously low urine output (CLAUDE.md; SRS §3.7). Do not "fix" this by
 * summing them.
 */
export const EXCLUDED_FROM_DAILY_NET_FLUID_BALANCE_LOINC_CODES: ReadonlySet<string> = new Set([
  VOIDED_URINE_LOINC_CODE,
  BODY_WEIGHT_LOINC_CODE,
  RESTING_HEART_RATE_LOINC_CODE,
]);

export function countsTowardDailyNetFluidBalance(loincCode: string): boolean {
  return DAILY_NET_FLUID_BALANCE_LOINC_CODES.has(loincCode);
}

export interface FluidBalanceObservation {
  readonly loincCode: string;
  /** Canonical mL value (ADR-0004). Never a rounded display figure. */
  readonly valueMl: number;
}

/**
 * Sum Daily Net Fluid Balance from canonical values, filtering by
 * `DAILY_NET_FLUID_BALANCE_LOINC_CODES` — most importantly, excluding
 * voided urine even if a caller passes every observation of the day
 * undifferentiated. Rounding, if any, is a display concern
 * (`packages/core/src/units`) and never happens here — see CLAUDE.md's
 * "rounded once" rule.
 */
export function sumDailyNetFluidBalanceMl(
  observations: readonly FluidBalanceObservation[],
): number {
  return observations
    .filter((observation) => countsTowardDailyNetFluidBalance(observation.loincCode))
    .reduce((total, observation) => total + observation.valueMl, 0);
}
