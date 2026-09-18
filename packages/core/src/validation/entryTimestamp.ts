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

import type { ValidationError } from './types.js';
import type { VolumetricValidationThresholds } from './thresholds.js';
import { TIER1_RULE_CODE } from './ruleCodes.js';

/**
 * The two Tier 1 rules that are about **when an entry happened**, extracted
 * so every entry type shares one definition of them.
 *
 * ## Why this file exists
 *
 * CLAUDE.md: validation is "defined once in `packages/core`". Until P3.S1 the
 * only entry type was volumetric, so `evaluateTier1` could own all seven rules
 * together and nothing noticed that two of them have nothing to do with
 * volume. A **meal** (SRS AC 2.4) has no value, no unit and no
 * Measured/Estimated toggle — but it absolutely still cannot have happened
 * tomorrow, and it cannot predate the surgery that created the stoma.
 *
 * The alternative was re-implementing those two checks in the meals path. That
 * is precisely the drift this package exists to prevent: the clock-skew
 * allowance is admin-managed configuration, and a second copy of the rule is
 * one that keeps comparing against the old threshold, or forgets the
 * surgery-date bound entirely, with nothing failing.
 *
 * `evaluateTier1` now composes these rather than duplicating them, so a
 * volumetric entry and a meal cannot disagree about what "in the future"
 * means.
 *
 * ## What is deliberately NOT here
 *
 * Anything about a value. `VALUE_NOT_NUMERIC`, `VALUE_NOT_POSITIVE`, the
 * representability bounds and `METHOD_REQUIRED` stay in `tier1.ts` with the
 * volumetric input they are about. A meal calling into a function that checks
 * a volume it does not have would be worse than a little duplication.
 */

export interface EntryTimestampInput {
  /**
   * The field identifier any resulting error names. Supplied by the caller
   * because it differs per entry type — a volumetric entry reports against
   * its value field, a meal against `effectiveDateTime` — and because
   * `ValidationError` carries a field and a code and nothing else
   * (docs/security-hipaa.md: "field identifiers and rule codes, never the
   * offending value").
   */
  readonly field: string;
  /** The clinical moment the entry describes. */
  readonly effectiveDateTime: Date;
  /** The patient's surgery date, or `null` when it is not yet known (no local profile until P4.S1). */
  readonly surgeryDate: Date | null;
  /** Injected, never read from the ambient clock — the same discipline `VolumetricEntryInput.now` keeps, so these stay pure functions. */
  readonly now: Date;
}

/**
 * Future timestamps beyond the admin-managed clock-skew allowance are
 * structurally impossible: they claim an event that has not happened yet.
 *
 * The allowance is a threshold read from configuration, never a constant —
 * it is the same `sync_clock_skew_allowance_seconds` row the sync contract's
 * §3.8 check uses, expressed in milliseconds.
 */
export function checkEntryNotInFuture(
  input: EntryTimestampInput,
  thresholds: VolumetricValidationThresholds,
): ValidationError | null {
  const latestAllowedMs = input.now.getTime() + thresholds.maxClockSkewMs;
  if (input.effectiveDateTime.getTime() > latestAllowedMs) {
    return { field: input.field, ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_IN_FUTURE };
  }
  return null;
}

/** An entry cannot predate the patient's surgery — there was no stoma yet. */
export function checkEntryNotBeforeSurgery(input: EntryTimestampInput): ValidationError | null {
  if (input.surgeryDate === null) return null;
  if (input.effectiveDateTime.getTime() < input.surgeryDate.getTime()) {
    return { field: input.field, ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_BEFORE_SURGERY };
  }
  return null;
}

/**
 * Both timestamp rules, in the order `docs/sync-contract.md` §6.2 lists them,
 * so two implementations walk a patient through the same correction sequence.
 */
export function evaluateEntryTimestamp(
  input: EntryTimestampInput,
  thresholds: VolumetricValidationThresholds,
): ValidationError[] {
  return [checkEntryNotInFuture(input, thresholds), checkEntryNotBeforeSurgery(input)].filter(
    (error): error is ValidationError => error !== null,
  );
}
