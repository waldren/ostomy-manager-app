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

import { readRangeForm } from './rangeForm';

const LIMITS = { minValue: 0.0001, maxValue: 99999999.9999 };
const SIGNED = { minValue: -99999999.9999, maxValue: 99999999.9999 };

function read(
  lowText: string,
  highText: string,
  options: Partial<Parameters<typeof readRangeForm>[0]> = {},
) {
  return readRangeForm({
    lowText,
    highText,
    measurementSystem: 'metric',
    limits: LIMITS,
    ...options,
  });
}

/**
 * The "set my own range" form (P4.S3 slice 4). The server re-checks all of it
 * (§7.6); what this pins is that the phone stores what the server will accept,
 * so a refusal happens on the form rather than in the correction inbox.
 */
describe('readRangeForm', () => {
  it('stores a metric value exactly as typed', () => {
    expect(read('600', '1500.25')).toEqual({
      status: 'valid',
      lowValue: '600',
      highValue: '1500.25',
    });
  });

  it('accepts one bound alone, as a floor or a ceiling', () => {
    expect(read('1000', '')).toEqual({ status: 'valid', lowValue: '1000', highValue: null });
    expect(read(' ', '900')).toEqual({ status: 'valid', lowValue: null, highValue: '900' });
  });

  it('needs at least one bound', () => {
    expect(read('', '')).toEqual({
      status: 'invalid',
      errors: [{ field: 'low', code: 'needs-a-bound' }],
    });
  });

  /** `Number('1e3')` is 1000 and `Number('')` is 0; neither is a number the patient typed. */
  it.each(['abc', '1e3', '5,5', '1.', '.5'])('refuses %p as not a number', (text) => {
    expect(read(text, '')).toEqual({
      status: 'invalid',
      errors: [{ field: 'low', code: 'not-a-number' }],
    });
  });

  it('refuses more decimal places than the column holds, rather than rounding', () => {
    expect(read('600.12345', '')).toEqual({
      status: 'invalid',
      errors: [{ field: 'low', code: 'too-precise' }],
    });
  });

  /**
   * ADR-0005's trap, the one `imperialEntry.spec.tsx` exists for: `ozToMl(20)`
   * is 591.4705912, and un-rounded the server refuses it for having more than
   * four decimal places the patient never typed.
   */
  it('converts an imperial value to millilitres at the column scale', () => {
    expect(read('20', '50', { measurementSystem: 'imperial' })).toEqual({
      status: 'valid',
      lowValue: '591.4706',
      highValue: '1478.6765',
    });
  });

  it('refuses a value outside the type limits', () => {
    expect(read('0', '')).toEqual({
      status: 'invalid',
      errors: [{ field: 'low', code: 'outside-limits' }],
    });
    expect(read('', '100000000')).toEqual({
      status: 'invalid',
      errors: [{ field: 'high', code: 'outside-limits' }],
    });
  });

  it('accepts a negative value only where the type allows one (net fluid balance)', () => {
    expect(read('-500', '').status).toBe('invalid');
    expect(read('-500', '', { limits: SIGNED })).toEqual({
      status: 'valid',
      lowValue: '-500',
      highValue: null,
    });
  });

  it('refuses an upper bound below the lower one', () => {
    expect(read('900', '600')).toEqual({
      status: 'invalid',
      errors: [{ field: 'high', code: 'below-low' }],
    });
  });

  it('allows equal bounds, which the server also accepts', () => {
    expect(read('700', '700').status).toBe('valid');
  });

  it('reports both fields when both are wrong', () => {
    const result = read('x', 'y');
    expect(result.status === 'invalid' ? result.errors.map((e) => e.field) : []).toEqual([
      'low',
      'high',
    ]);
  });
});
