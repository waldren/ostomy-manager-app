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
 * The surgery-date bound, in its own file because the rule is a comparison
 * between two things of different kinds — an instant and a calendar date — and
 * getting that wrong is a Tier 1 hard block on real entries rather than a
 * cosmetic slip.
 *
 * `volumetric.spec.ts` and `volumeless.spec.ts` cover it as part of their
 * engines. This covers the cases that are only about the zone, where the same
 * instant must come out differently depending on whose day it fell on.
 */

import { describe, expect, it } from 'vitest';

import { checkEntryNotBeforeSurgery, type EntryTimestampInput } from './entryTimestamp.js';
import { TIER1_RULE_CODE } from './ruleCodes.js';

const SURGERY_DATE = '2026-10-09';

function input(overrides: Partial<EntryTimestampInput> = {}): EntryTimestampInput {
  return {
    field: 'effectiveDateTime',
    effectiveDateTime: new Date('2026-10-09T12:00:00.000Z'),
    surgeryDate: SURGERY_DATE,
    enteredTimezone: 'UTC',
    // Irrelevant to this rule; `checkEntryNotInFuture` is the one that reads it.
    now: new Date('2026-10-09T12:00:00.000Z'),
    ...overrides,
  };
}

const blocked = {
  field: 'effectiveDateTime',
  ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_BEFORE_SURGERY,
};

describe('checkEntryNotBeforeSurgery', () => {
  it('accepts an entry after the surgery date', () => {
    expect(
      checkEntryNotBeforeSurgery(
        input({ effectiveDateTime: new Date('2026-10-20T08:00:00.000Z') }),
      ),
    ).toBeNull();
  });

  it('accepts an entry on the surgery date', () => {
    expect(checkEntryNotBeforeSurgery(input())).toBeNull();
  });

  it('blocks an entry on the day before', () => {
    expect(
      checkEntryNotBeforeSurgery(
        input({ effectiveDateTime: new Date('2026-10-08T12:00:00.000Z') }),
      ),
    ).toEqual(blocked);
  });

  it('allows anything when there is no surgery date', () => {
    expect(
      checkEntryNotBeforeSurgery(
        input({ surgeryDate: null, effectiveDateTime: new Date('2000-01-01T00:00:00.000Z') }),
      ),
    ).toBeNull();
  });

  /**
   * The table this rule exists for.
   *
   * Every row is the SAME instant — `2026-10-08T23:00:00Z` — and the same surgery
   * date. What differs is the zone the entry was made in, and therefore which
   * calendar day it fell on for the patient. Comparing the instant against the
   * surgery date's UTC midnight gave the same answer for all of them (blocked),
   * which was right for two rows and wrong for the other three.
   *
   * The wrong ones are not an edge case: they are every patient east of UTC,
   * logging on the day of their own surgery. That is SRS §3.0's hospital-bed
   * patient, hard-blocked for up to fourteen hours.
   */
  describe('one instant, five zones', () => {
    const INSTANT = new Date('2026-10-08T23:00:00.000Z');

    it.each([
      ['Pacific/Kiritimati', 'UTC+14', '2026-10-09', null],
      ['Pacific/Auckland', 'UTC+13', '2026-10-09', null],
      ['Asia/Tokyo', 'UTC+9', '2026-10-09', null],
      ['UTC', 'UTC', '2026-10-08', blocked],
      ['America/Los_Angeles', 'UTC-7', '2026-10-08', blocked],
    ])('%s (%s) — the entry fell on %s', (zone, _offset, _localDate, expected) => {
      expect(
        checkEntryNotBeforeSurgery(input({ effectiveDateTime: INSTANT, enteredTimezone: zone })),
      ).toEqual(expected);
    });
  });

  /**
   * And the mirror, which the instant comparison got wrong in the other
   * direction: an entry whose instant is after the surgery date's UTC midnight but
   * whose local day is before the surgery. The old rule ACCEPTED these, so a
   * patient in Los Angeles could log an entry dated the day before they had a
   * stoma.
   */
  it('blocks an entry whose instant is after UTC midnight but whose local day is earlier', () => {
    expect(
      checkEntryNotBeforeSurgery(
        input({
          effectiveDateTime: new Date('2026-10-09T04:00:00.000Z'),
          enteredTimezone: 'America/Los_Angeles',
        }),
      ),
    ).toEqual(blocked);
  });

  /** The field the caller named travels through, because that is what routes the message to a control. */
  it('reports the caller’s field', () => {
    expect(
      checkEntryNotBeforeSurgery(
        input({
          field: 'valueQuantity.value',
          effectiveDateTime: new Date('2026-10-01T12:00:00.000Z'),
        }),
      ),
    ).toEqual({
      field: 'valueQuantity.value',
      ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_BEFORE_SURGERY,
    });
  });
});
