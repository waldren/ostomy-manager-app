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
 * LOINC codes whose canonical mL values count as INTAKE toward Daily Net
 * Fluid Balance (SRS §3.5: "total fluid intake minus total stoma output
 * (and other recorded losses)"). Kept separate from the output set below —
 * rather than one undifferentiated "counts toward the balance" set — so
 * the subtraction in `netDailyFluidBalanceMl` is structural: which set an
 * observation falls into determines its sign, not a convention a caller
 * has to get right.
 */
export const NET_FLUID_BALANCE_INTAKE_LOINC_CODES: ReadonlySet<string> = new Set([
  FLUID_INTAKE_LOINC_CODE,
]);

/**
 * LOINC codes whose canonical mL values count as OUTPUT (a loss) toward
 * Daily Net Fluid Balance. Stoma output today; SRS §3.5's "(and other
 * recorded losses)" is the room this set — not a single hardcoded code —
 * exists to leave for later without touching the subtraction logic.
 *
 * Voided urine is deliberately NOT a member of this set — see
 * `EXCLUDED_FROM_DAILY_NET_FLUID_BALANCE_LOINC_CODES` below.
 */
export const NET_FLUID_BALANCE_OUTPUT_LOINC_CODES: ReadonlySet<string> = new Set([
  STOMA_OUTPUT_LOINC_CODE,
]);

/**
 * The union of the intake and output sets — every LOINC code that
 * participates in Daily Net Fluid Balance at all, regardless of sign.
 * Exported for callers (e.g. UI code deciding which observations are even
 * relevant to this signal) that need "does this count at all," not "which
 * side of the subtraction."
 */
export const DAILY_NET_FLUID_BALANCE_LOINC_CODES: ReadonlySet<string> = new Set([
  ...NET_FLUID_BALANCE_INTAKE_LOINC_CODES,
  ...NET_FLUID_BALANCE_OUTPUT_LOINC_CODES,
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

/**
 * Voided urine, as its own hydration signal.
 *
 * The set above says what urine is NOT part of. This says what it IS: one of
 * the four hydration signals in its own right (CLAUDE.md, SRS §3.7), and the
 * one a reader is most likely to assume the balance already covers.
 *
 * A UI showing urine separately needs to pick those observations out, and
 * without this it would need the raw LOINC code — which this module
 * deliberately withholds, so that it does not become a second terminology
 * entry point ahead of `packages/core/src/fhir` (ADR-0007). A named set is
 * the behaviour half of the same fact the exclusion set states negatively,
 * and keeping both here means a code that stops being excluded and a code
 * that stops being the urine signal cannot drift apart.
 *
 * A set rather than a single code because that is the shape every other
 * classification here takes, and because `EXCLUDED_...` already anticipates
 * this one growing — a urostomy would be a second urine code, and v1
 * deliberately does not cover urostomy (SRS Phase 4 Appendix A).
 */
export const URINE_OUTPUT_LOINC_CODES: ReadonlySet<string> = new Set([VOIDED_URINE_LOINC_CODE]);

/**
 * The `urine_color` value set's member codes, **pale to dark**.
 *
 * The order is the clinical content of this scale — darker means more
 * concentrated — so any surface listing recorded colours has to know it, or it
 * renders a sequence that carries no information above copy inviting the
 * reader to read darkness off it.
 *
 * ## Why this duplicates the database, and what stops it drifting
 *
 * The authoritative order is `value_set_members.sort_order`, seeded by the
 * P3.S2 migration. `apps/mobile` reads it from the device's value-set cache
 * and needs nothing here. `apps/web` has no value-set fetch at all, and
 * inventing a second ordering inside that app would be strictly worse than one
 * shared list — both clients must agree, and this is the only package both
 * depend on.
 *
 * So it is a deliberate second copy, and the drift is closed by a test rather
 * than by hope: `observations.integration.spec.ts` asserts this list equals
 * the migration's seeded `sort_order` against real PostgreSQL. Adding a step to
 * the migration without adding it here fails there.
 *
 * Codes only, never labels — the words come from the i18n catalog (ADR-0006),
 * and a member an admin adds later renders through the shared fallback.
 */
export const URINE_COLOR_CODES_PALE_TO_DARK: readonly string[] = [
  'pale_straw',
  'straw',
  'yellow',
  'dark_yellow',
  'amber',
  'brown',
];

/**
 * Sorts recorded colour codes pale to dark.
 *
 * A code this release does not know — a member added after it shipped — sorts
 * last rather than being dropped: it is a real observation, and the scale only
 * ever grows darker at the end in practice. Stable within the unknowns, so the
 * output is deterministic.
 */
export function sortUrineColorCodes(codes: readonly string[]): readonly string[] {
  const rank = (code: string) => {
    const index = URINE_COLOR_CODES_PALE_TO_DARK.indexOf(code);
    return index === -1 ? URINE_COLOR_CODES_PALE_TO_DARK.length : index;
  };
  return [...codes].sort((a, b) => rank(a) - rank(b));
}

/** Whether this observation is the urine-output hydration signal (SRS §3.7). */
export function isUrineOutputSignal(loincCode: string): boolean {
  return URINE_OUTPUT_LOINC_CODES.has(loincCode);
}

export function countsTowardDailyNetFluidBalance(loincCode: string): boolean {
  return DAILY_NET_FLUID_BALANCE_LOINC_CODES.has(loincCode);
}

export interface FluidBalanceObservation {
  readonly loincCode: string;
  /** Canonical mL value (ADR-0004). Never a rounded display figure. */
  readonly valueMl: number;
}

/**
 * Compute Daily Net Fluid Balance from canonical values: total intake
 * MINUS total output (SRS §3.5). The sign is structural, not the caller's
 * job — an observation's LOINC code determines which set it falls into
 * (`NET_FLUID_BALANCE_INTAKE_LOINC_CODES` adds, `..._OUTPUT_LOINC_CODES`
 * subtracts), so an output-dominant day produces a negative result, which
 * is the classic dehydration presentation (CLAUDE.md; SRS §3.5).
 *
 * Filters by the two include-sets above — most importantly, excluding
 * voided urine even if a caller passes every observation of the day
 * undifferentiated; an observation whose LOINC code is in neither set
 * (e.g. voided urine, weight, heart rate) contributes nothing, in either
 * direction. Rounding, if any, is a display concern
 * (`packages/core/src/units`) and never happens here — see CLAUDE.md's
 * "rounded once" rule.
 *
 * Named `netDailyFluidBalanceMl`, not `sumDailyNetFluidBalanceMl` — this
 * value is a difference, not a sum, and the old name read as "the total"
 * in a way that invited exactly the sign bug this replaces.
 */
export function netDailyFluidBalanceMl(observations: readonly FluidBalanceObservation[]): number {
  return observations.reduce((balance, observation) => {
    if (NET_FLUID_BALANCE_INTAKE_LOINC_CODES.has(observation.loincCode)) {
      return balance + observation.valueMl;
    }
    if (NET_FLUID_BALANCE_OUTPUT_LOINC_CODES.has(observation.loincCode)) {
      return balance - observation.valueMl;
    }
    return balance;
  }, 0);
}
