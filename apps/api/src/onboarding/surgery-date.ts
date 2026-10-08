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

import { SURGERY_DATE_RULE_CODE, type SurgeryDateRuleCode } from '@ostomy/core/validation';

import { MAX_SURGERY_DATE_AGE_YEARS, MAX_TIMEZONE_HOURS_AHEAD_OF_UTC } from './onboarding-wire';

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * The surgery date's two bounds, as a pure function of the date and the clock.
 *
 * Pure, and taking `now` as a parameter, for a reason the integration suite
 * demonstrated: the upper bound deliberately tolerates the furthest-ahead
 * timezone, so whether a given date is inside or outside the allowance depends
 * on the hour of the UTC day. A test against the ambient clock therefore asserts
 * something different at 09:00 than at 11:00 — it passes, and proves whichever
 * of the two cases the suite happened to run in. With the clock as an argument,
 * both cases are stated outright in `surgery-date.spec.ts`.
 *
 * Returns the rule that was broken, or `null`. It does not build the HTTP
 * refusal: the codes are `@ostomy/core/validation`'s, shared with the onboarding
 * screen that has to turn each one into something the patient can act on, and
 * the envelope belongs to the service.
 */
export function surgeryDateViolation(surgeryDate: Date, now: Date): SurgeryDateRuleCode | null {
  /**
   * **No future date.** This value becomes the Tier 1 lower timestamp bound, so a
   * surgery date in the future makes every entry the patient can make fail that
   * rule — the app would accept onboarding and then refuse the first thing they
   * logged, citing a date chosen on a screen they have already left.
   *
   * The allowance is what keeps that from refusing the patient SRS §3.0
   * describes; `MAX_TIMEZONE_HOURS_AHEAD_OF_UTC` carries the measurements.
   */
  const latestAnywhereOnEarth = now.getTime() + MAX_TIMEZONE_HOURS_AHEAD_OF_UTC * MS_PER_HOUR;
  if (surgeryDate.getTime() > latestAnywhereOnEarth) {
    return SURGERY_DATE_RULE_CODE.IN_THE_FUTURE;
  }

  /**
   * **Nothing absurdly old.** A typo of `1025-03-04` passes every shape rule and
   * silently disables that same bound for the life of the account, with nothing
   * downstream reporting a rule that never fires.
   *
   * No timezone allowance here: the bound is fifty years wide, so a few hours
   * either way cannot decide a case, and adding slack would only blur it.
   */
  const oldest = new Date(now);
  oldest.setUTCFullYear(oldest.getUTCFullYear() - MAX_SURGERY_DATE_AGE_YEARS);
  if (surgeryDate.getTime() < oldest.getTime()) {
    return SURGERY_DATE_RULE_CODE.IMPLAUSIBLY_OLD;
  }

  return null;
}

/**
 * `YYYY-MM-DD` to the instant the `@db.Date` column stores.
 *
 * `z.iso.date()` has already fixed the shape, so this parses rather than
 * validates. `T00:00:00.000Z` explicitly: `new Date('2026-01-02')` is UTC
 * midnight by spec, but being explicit is what stops a later edit to a non-ISO
 * format silently becoming LOCAL midnight and shifting the stored date by a day
 * for half the world — on a value that bounds every entry the patient makes.
 */
export function toSurgeryDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}
