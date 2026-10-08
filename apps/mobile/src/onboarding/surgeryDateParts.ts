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

/** What the patient typed into the three fields, unparsed. */
export interface SurgeryDateParts {
  readonly year: string;
  readonly month: string;
  readonly day: string;
}

export const EMPTY_SURGERY_DATE_PARTS: SurgeryDateParts = { year: '', month: '', day: '' };

/**
 * Three separate fields rather than one date picker, and the reason is the
 * population rather than the implementation.
 *
 * A spinner is a poor way to reach a date that may be years back — this app
 * accepts a surgery up to fifty years ago — and `@react-native-community/
 * datetimepicker` is a native module, so adding it means a native rebuild for a
 * single screen. Three labelled numeric fields are reachable with a screen
 * reader, typable without sight of a calendar grid, and — the part a picker also
 * gets wrong — carry no DD/MM versus MM/DD ambiguity, because each field says
 * which part it is.
 *
 * ## What this checks, and what it leaves to the server
 *
 * It checks the two things the device can answer with certainty: that the parts
 * name a real day, and that the day is not in the future **in the device's own
 * timezone**. The server has to be lenient about the second — it receives a
 * calendar date and no zone, so it allows the furthest-ahead zone (see
 * `apps/api/src/onboarding/surgery-date.ts`) — while here the zone is known, so
 * the check is exact and the patient gets an answer with no round trip.
 *
 * It does NOT check the fifty-year bound. That number lives server-side only, on
 * purpose: the client never needs it, only the copy for the code that comes back,
 * and a second copy of a bound is how the two drift. Onboarding requires
 * connectivity regardless — provisioning is one online call — so a patient who
 * slips a century learns it from the response on the field they typed it in.
 *
 * Client-side validation here is a UX affordance, per CLAUDE.md. The server
 * re-enforces every rule and is the only enforcer that counts.
 */
export type SurgeryDateEntry =
  /** Not all three fields are filled in. Not an error — nobody should be scolded mid-typing. */
  | { readonly status: 'incomplete' }
  | { readonly status: 'invalid'; readonly ruleCode: SurgeryDateRuleCode }
  /** `YYYY-MM-DD`, the wire shape `POST /api/v1/onboarding` takes. */
  | { readonly status: 'valid'; readonly wireDate: string };

const YEAR_DIGITS = 4;

/**
 * Only digits, and only as many as the field can hold.
 *
 * Applied as the fields are typed into rather than at submit, so a patient who
 * pastes something cannot leave characters in a field that will later be refused
 * for a reason they cannot see.
 */
export function digitsOnly(value: string, maxLength: number): string {
  return value.replace(/\D/g, '').slice(0, maxLength);
}

export const SURGERY_DATE_FIELD_MAX_LENGTH = {
  year: YEAR_DIGITS,
  month: 2,
  day: 2,
} as const;

/**
 * The three parts as one answer.
 *
 * `today` is the patient's own local date (`YYYY-MM-DD`), passed in rather than
 * read here, so this stays a pure function — the discipline `packages/core`'s
 * validation keeps for the same reason, and what lets the timezone cases be
 * stated in a test instead of depending on where the test runs.
 */
export function readSurgeryDateParts(parts: SurgeryDateParts, today: string): SurgeryDateEntry {
  const year = parts.year.trim();
  const month = parts.month.trim();
  const day = parts.day.trim();

  if (year === '' || month === '' || day === '') return { status: 'incomplete' };

  /**
   * A four-digit year, required rather than inferred.
   *
   * `26` could be 2026 or 1926, and both are inside the fifty-year bound. Guessing
   * would put a Tier 1 lower bound a century off on the strength of an assumption
   * the patient never saw — so this asks again instead. The field's hint carries
   * the example.
   */
  if (year.length !== YEAR_DIGITS) {
    return { status: 'invalid', ruleCode: SURGERY_DATE_RULE_CODE.NOT_A_DATE };
  }

  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  if (
    !Number.isInteger(yearNumber) ||
    !Number.isInteger(monthNumber) ||
    !Number.isInteger(dayNumber)
  ) {
    return { status: 'invalid', ruleCode: SURGERY_DATE_RULE_CODE.NOT_A_DATE };
  }

  /**
   * Round-tripped through `Date.UTC` rather than range-checked by hand, because
   * that is what makes 31 February and 29 February 2027 wrong for the right
   * reason: `Date.UTC` rolls them forward into March, so the parts coming back
   * differ from the parts going in. A month-length table would have to carry the
   * leap-year rule itself and would be one more place to get it wrong.
   */
  const candidate = new Date(Date.UTC(yearNumber, monthNumber - 1, dayNumber));
  const isRealDay =
    candidate.getUTCFullYear() === yearNumber &&
    candidate.getUTCMonth() === monthNumber - 1 &&
    candidate.getUTCDate() === dayNumber;
  if (!isRealDay) {
    return { status: 'invalid', ruleCode: SURGERY_DATE_RULE_CODE.NOT_A_DATE };
  }

  const wireDate = candidate.toISOString().slice(0, 10);

  /**
   * Compared as strings, which is exact for `YYYY-MM-DD` and avoids the trap this
   * whole file exists around: two instants compared across a timezone boundary.
   * ISO dates sort lexicographically, and both sides are the same shape.
   */
  if (wireDate > today) {
    return { status: 'invalid', ruleCode: SURGERY_DATE_RULE_CODE.IN_THE_FUTURE };
  }

  return { status: 'valid', wireDate };
}

/** The parts a profile's stored `YYYY-MM-DD` came from, so a re-run of onboarding opens pre-filled rather than blank. */
export function toSurgeryDateParts(wireDate: string): SurgeryDateParts {
  const [year = '', month = '', day = ''] = wireDate.split('-');
  return { year, month, day };
}
