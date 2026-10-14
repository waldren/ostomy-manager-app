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
  checkEntryNotBeforeSurgery,
  evaluateEntryTimestamp,
  type ValidationError,
  type VolumetricValidationThresholds,
} from '@ostomy/core/validation';

/** The field a meal's timestamp errors name — the wire spelling, as the server reports it. */
export const MEAL_TIMESTAMP_FIELD = 'effectiveDateTime';

export type MealTimestampCheck =
  | { readonly kind: 'ok' }
  | { readonly kind: 'blocked'; readonly errors: readonly ValidationError[] }
  /** The time is later than now and this phone has never fetched the allowance that decides whether that is too late. */
  | { readonly kind: 'thresholds-unavailable' };

/**
 * The two Tier 1 rules a meal is subject to — both about WHEN — run on the
 * device before the save (#135).
 *
 * Add Meal ran no client validation at all, and said why: its timestamp was
 * read from the clock and could not be edited, so neither rule could fire.
 * Backdating ends that, and without this a meal dated before the surgery would
 * save locally, be refused by the server, and reach the correction inbox —
 * a round-trip to tell the patient something the phone already knew.
 *
 * ## No threshold is invented when the cache is empty
 *
 * Unlike the volumetric screens, a meal must not be blocked just because
 * `validation_thresholds_cache` has never been filled: the only threshold a
 * meal needs is the clock-skew allowance, and that only for a time that is
 * actually in the future. So:
 *
 * - the surgery-date rule needs no threshold and always runs;
 * - a time at or before `now` cannot be "too far in the future" under ANY
 *   allowance — the admin bound is positive — so it is decided without one;
 * - only a future time with no cached allowance is undecidable, and that is
 *   refused with the same "this phone does not have your safe ranges yet"
 *   message the other screens use, rather than checked against a made-up
 *   number (CLAUDE.md: an unfetched cache blocks rather than inventing).
 */
export function checkMealTimestamp(input: {
  readonly effectiveDateTime: Date;
  readonly surgeryDate: string | null;
  readonly enteredTimezone: string;
  readonly now: Date;
  readonly thresholds: VolumetricValidationThresholds | undefined;
}): MealTimestampCheck {
  const timestamp = {
    field: MEAL_TIMESTAMP_FIELD,
    effectiveDateTime: input.effectiveDateTime,
    surgeryDate: input.surgeryDate,
    enteredTimezone: input.enteredTimezone,
    now: input.now,
  };

  if (input.thresholds !== undefined) {
    const errors = evaluateEntryTimestamp(timestamp, input.thresholds);
    return errors.length === 0 ? { kind: 'ok' } : { kind: 'blocked', errors };
  }

  const beforeSurgery = checkEntryNotBeforeSurgery(timestamp);
  if (beforeSurgery !== null) return { kind: 'blocked', errors: [beforeSurgery] };
  if (input.effectiveDateTime.getTime() > input.now.getTime()) {
    return { kind: 'thresholds-unavailable' };
  }
  return { kind: 'ok' };
}
