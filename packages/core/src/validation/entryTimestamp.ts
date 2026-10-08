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

import { toLocalDate } from '../units/localDate.js';

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
  /**
   * The patient's surgery date as `YYYY-MM-DD`, or `null` when it is not known
   * (no profile, which `apps/api` refuses to write against and a client routes to
   * onboarding).
   *
   * A **calendar date**, not an instant, and the type says so because the
   * previous `Date` was the whole defect: see `checkEntryNotBeforeSurgery`.
   */
  readonly surgeryDate: string | null;
  /**
   * The IANA zone the entry was made in (ADR-0016), client-asserted exactly as
   * `enteredMeasurementSystem` is.
   *
   * Required by `checkEntryNotBeforeSurgery`, which compares calendar days and
   * therefore has to know whose day. Every caller already has it: it travels on
   * the wire (`docs/sync-contract.md` §7.2) and is stored per row.
   */
  readonly enteredTimezone: string;
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

/**
 * An entry cannot predate the patient's surgery — there was no stoma yet.
 *
 * ## Calendar days, not instants, and the difference is a Tier 1 block
 *
 * A surgery happened on a DAY. Comparing the entry's instant against that day's
 * UTC midnight is wrong by the patient's UTC offset, and wrong in the direction
 * that refuses real entries for everyone east of UTC: a patient in Tokyo who
 * onboards at 08:00 on their surgery day stores `2026-10-09`, which is
 * `2026-10-09T00:00:00Z`, while the entry they make a minute later is
 * `2026-10-08T23:01:00Z` — *earlier*, by the clock, than a surgery that had
 * already happened. They were hard-blocked from logging anything for an hour,
 * and a patient in Kiritimati (UTC+14) for fourteen hours. SRS §3.0's
 * hospital-bed patient is precisely the one this hit.
 *
 * So the comparison is `YYYY-MM-DD` against `YYYY-MM-DD`, in the zone the entry
 * was made in. ISO dates sort lexicographically, both sides are the same shape,
 * and no offset enters the arithmetic at all. It is also stricter in the
 * direction that matters: an entry backdated to the day before the surgery is
 * still refused, in every zone.
 *
 * ADR-0016 called `local_date` "a grouping key only"; this is the one rule that
 * also compares it, and the ADR carries an amendment saying so. Derived here
 * rather than taken as a parameter, through the same `toLocalDate` the server
 * uses to populate the column, so a caller cannot pass a local date that
 * disagrees with the instant beside it.
 */
export function checkEntryNotBeforeSurgery(input: EntryTimestampInput): ValidationError | null {
  if (input.surgeryDate === null) return null;
  const entryLocalDate = toLocalDate(input.effectiveDateTime, input.enteredTimezone);
  if (entryLocalDate < input.surgeryDate) {
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
