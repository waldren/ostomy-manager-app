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

import {
  digitsOnly,
  readSurgeryDateParts,
  toSurgeryDateParts,
  type SurgeryDateParts,
} from './surgeryDateParts';

const TODAY = '2026-10-08';

function parts(overrides: Partial<SurgeryDateParts> = {}): SurgeryDateParts {
  return { year: '2026', month: '09', day: '01', ...overrides };
}

describe('readSurgeryDateParts', () => {
  it('assembles the three parts into the wire date', () => {
    expect(readSurgeryDateParts(parts(), TODAY)).toEqual({
      status: 'valid',
      wireDate: '2026-09-01',
    });
  });

  it('zero-pads a single-digit month and day, so the wire shape is always ten characters', () => {
    expect(readSurgeryDateParts(parts({ month: '9', day: '1' }), TODAY)).toEqual({
      status: 'valid',
      wireDate: '2026-09-01',
    });
  });

  describe('an unfinished answer is not an error', () => {
    /**
     * A patient filling in a year and reaching for the month must not be told
     * their date is wrong. The screen shows a message only once all three fields
     * have something in them, which is what `incomplete` carries — and it is a
     * separate state from `invalid` precisely so the screen cannot conflate them.
     */
    it.each([
      ['no year', { year: '' }],
      ['no month', { month: '' }],
      ['no day', { day: '' }],
      ['nothing at all', { year: '', month: '', day: '' }],
      ['whitespace only', { year: ' ', month: ' ', day: ' ' }],
    ])('reports incomplete with %s', (_label, overrides) => {
      expect(readSurgeryDateParts(parts(overrides), TODAY)).toEqual({ status: 'incomplete' });
    });
  });

  describe('a date that does not exist', () => {
    /**
     * `Date.UTC` rolls an impossible day forward into the next month, so the
     * round-trip comparison is what catches these. Without it, 31 February would
     * be accepted and stored as 3 March — a Tier 1 lower bound two days off, with
     * nothing anywhere reporting it.
     */
    it.each([
      ['31 February', { month: '02', day: '31' }],
      ['29 February in a non-leap year', { year: '2027', month: '02', day: '29' }],
      ['month 13', { month: '13', day: '01' }],
      ['month 0', { month: '0', day: '01' }],
      ['day 0', { month: '09', day: '0' }],
      ['day 32', { month: '09', day: '32' }],
    ])('refuses %s', (_label, overrides) => {
      expect(readSurgeryDateParts(parts(overrides), TODAY)).toEqual({
        status: 'invalid',
        ruleCode: SURGERY_DATE_RULE_CODE.NOT_A_DATE,
      });
    });

    it('accepts 29 February in a leap year', () => {
      expect(readSurgeryDateParts({ year: '2024', month: '02', day: '29' }, TODAY)).toEqual({
        status: 'valid',
        wireDate: '2024-02-29',
      });
    });
  });

  describe('the year must be four digits, not inferred', () => {
    /**
     * `26` is 2026 or 1926, and both are inside the fifty-year bound the server
     * enforces. Guessing would put the Tier 1 lower bound a century out on the
     * strength of an assumption the patient never saw.
     */
    it.each([
      ['two digits', '26'],
      ['three digits', '202'],
      ['one digit', '2'],
    ])('refuses a %s year', (_label, year) => {
      expect(readSurgeryDateParts(parts({ year }), TODAY)).toEqual({
        status: 'invalid',
        ruleCode: SURGERY_DATE_RULE_CODE.NOT_A_DATE,
      });
    });
  });

  describe('the future check is exact, because the device knows its own timezone', () => {
    it('accepts the patient’s own today — the hospital-bed case SRS §3.0 describes', () => {
      expect(readSurgeryDateParts({ year: '2026', month: '10', day: '08' }, TODAY)).toEqual({
        status: 'valid',
        wireDate: '2026-10-08',
      });
    });

    /**
     * `today` is the DEVICE's local date, so this case is the same whether the
     * patient is in Auckland or Los Angeles — which is the point of comparing
     * calendar dates as strings rather than instants. The server cannot be this
     * strict: it gets no timezone and has to allow the furthest-ahead zone.
     */
    it('refuses tomorrow', () => {
      expect(readSurgeryDateParts({ year: '2026', month: '10', day: '09' }, TODAY)).toEqual({
        status: 'invalid',
        ruleCode: SURGERY_DATE_RULE_CODE.IN_THE_FUTURE,
      });
    });

    it('refuses a date in a later year', () => {
      expect(readSurgeryDateParts({ year: '2027', month: '01', day: '01' }, TODAY)).toEqual({
        status: 'invalid',
        ruleCode: SURGERY_DATE_RULE_CODE.IN_THE_FUTURE,
      });
    });
  });

  /**
   * Deliberately NOT checked here. The fifty-year bound lives server-side only, so
   * this parses cleanly and the refusal arrives from the API — which is what the
   * screen renders against this field. A client-side copy of that number is how
   * the two would drift.
   */
  it('passes a slipped century through for the server to refuse', () => {
    expect(readSurgeryDateParts({ year: '1025', month: '03', day: '04' }, TODAY)).toEqual({
      status: 'valid',
      wireDate: '1025-03-04',
    });
  });
});

describe('digitsOnly', () => {
  it('strips anything that is not a digit', () => {
    expect(digitsOnly('2o26', 4)).toBe('226');
    expect(digitsOnly('09/', 2)).toBe('09');
  });

  it('truncates to the field length, so a paste cannot leave hidden characters', () => {
    expect(digitsOnly('20261008', 4)).toBe('2026');
  });
});

describe('toSurgeryDateParts', () => {
  /**
   * Re-onboarding happens: a development reset, or a server-side purge, leaves this
   * device holding a profile the server does not have. Opening the screen pre-filled
   * from the local row makes that one tap rather than three fields retyped.
   */
  it('splits a stored wire date back into the three fields', () => {
    expect(toSurgeryDateParts('2026-09-01')).toEqual({ year: '2026', month: '09', day: '01' });
  });

  it('round-trips with readSurgeryDateParts', () => {
    expect(readSurgeryDateParts(toSurgeryDateParts('2024-02-29'), TODAY)).toEqual({
      status: 'valid',
      wireDate: '2024-02-29',
    });
  });
});
