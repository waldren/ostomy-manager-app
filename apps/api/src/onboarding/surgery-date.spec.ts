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

import { SURGERY_DATE_RULE_CODE } from '@ostomy/core/validation';
import { describe, expect, it } from 'vitest';

import { MAX_SURGERY_DATE_AGE_YEARS } from './onboarding-wire';
import { surgeryDateViolation, toSurgeryDate } from './surgery-date';

/**
 * A fixed instant, and every case states its own. That is the whole reason this
 * rule is a pure function: the upper bound tolerates the furthest-ahead timezone,
 * so for the same input the correct answer differs by the hour of the UTC day —
 * and a test against the ambient clock would assert whichever of the two the
 * suite happened to start in, passing either way.
 *
 * 2026-10-08T23:00:00Z is chosen because it is 08:00 the NEXT day in Tokyo: the
 * exact situation that was being refused.
 */
const TOKYO_MORNING_UTC = new Date('2026-10-08T23:00:00.000Z');
const MIDDAY_UTC = new Date('2026-10-08T12:00:00.000Z');

function violationFor(wireDate: string, now: Date) {
  return surgeryDateViolation(toSurgeryDate(wireDate), now);
}

describe('surgeryDateViolation', () => {
  it('accepts a date in the past', () => {
    expect(violationFor('2026-09-01', MIDDAY_UTC)).toBeNull();
  });

  it("accepts today's UTC date", () => {
    expect(violationFor('2026-10-08', MIDDAY_UTC)).toBeNull();
  });

  describe("the future bound tolerates the patient's timezone, because the request carries none", () => {
    /**
     * The patient SRS §3.0 describes: setting the app up in a hospital bed on the
     * day of the surgery. At 08:00 in Tokyo it is already 9 October there while
     * UTC is still 8 October, so that date's UTC midnight (09T00:00Z) is an hour
     * LATER than `now` (08T23:00Z) — and a strict comparison refused it, with a
     * message about a date that was simply today.
     *
     * This is the assertion that would fail if the allowance were removed as
     * "slack", and it fails deterministically, which the integration suite's
     * ambient clock could not give.
     */
    it("accepts today's date for a patient nine hours ahead of UTC", () => {
      expect(violationFor('2026-10-09', TOKYO_MORNING_UTC)).toBeNull();
    });

    it('accepts it for a patient fourteen hours ahead, the furthest zone in use', () => {
      // 02:00 on 9 October in Kiritimati (UTC+14) is 12:00 on 8 October UTC.
      expect(violationFor('2026-10-09', MIDDAY_UTC)).toBeNull();
    });

    it('still refuses a date beyond any real timezone', () => {
      // 12:00 UTC + 14h lands on the 9th, so the 10th is outside the allowance no
      // matter where the patient is.
      expect(violationFor('2026-10-10', MIDDAY_UTC)).toBe(SURGERY_DATE_RULE_CODE.IN_THE_FUTURE);
    });

    it('refuses a date a long way out, which is what a mistyped year looks like', () => {
      expect(violationFor('2027-10-08', MIDDAY_UTC)).toBe(SURGERY_DATE_RULE_CODE.IN_THE_FUTURE);
    });
  });

  describe('the past bound refuses a slipped century', () => {
    it('refuses a date implausibly far back', () => {
      expect(violationFor('1025-03-04', MIDDAY_UTC)).toBe(SURGERY_DATE_RULE_CODE.IMPLAUSIBLY_OLD);
    });

    /**
     * Parameterised from the constant rather than against a literal year, so
     * changing the bound moves these two cases with it instead of leaving a test
     * that pins a number the code no longer uses.
     */
    it('accepts a date just inside the bound', () => {
      const justInside = new Date(MIDDAY_UTC);
      justInside.setUTCFullYear(justInside.getUTCFullYear() - MAX_SURGERY_DATE_AGE_YEARS);
      justInside.setUTCDate(justInside.getUTCDate() + 1);

      expect(violationFor(justInside.toISOString().slice(0, 10), MIDDAY_UTC)).toBeNull();
    });

    it('refuses a date just outside it', () => {
      const justOutside = new Date(MIDDAY_UTC);
      justOutside.setUTCFullYear(justOutside.getUTCFullYear() - MAX_SURGERY_DATE_AGE_YEARS);
      justOutside.setUTCDate(justOutside.getUTCDate() - 1);

      expect(violationFor(justOutside.toISOString().slice(0, 10), MIDDAY_UTC)).toBe(
        SURGERY_DATE_RULE_CODE.IMPLAUSIBLY_OLD,
      );
    });
  });
});

describe('toSurgeryDate', () => {
  /**
   * UTC midnight, explicitly. The column is `@db.Date`, and a value parsed as
   * LOCAL midnight would be stored a day early or late for most of the world — on
   * the one field that bounds every entry the patient will ever make.
   */
  it('parses to UTC midnight of the calendar date, whatever the server timezone', () => {
    expect(toSurgeryDate('2026-09-01').toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('round-trips through the wire format unchanged', () => {
    expect(toSurgeryDate('2026-09-01').toISOString().slice(0, 10)).toBe('2026-09-01');
  });
});
