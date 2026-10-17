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

import { readRangeForm, toEditableText } from './rangeForm';

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
  it.each(['abc', '1e3', '5,5', '1.', '.5', '500 mL'])('refuses %p as not a number', (text) => {
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

  /** WCAG 3.3.3: each says what the app CAN store, so each is its own code. */
  it('refuses zero for a type whose values are positive, as "bigger than 0"', () => {
    expect(read('0', '')).toEqual({
      status: 'invalid',
      errors: [{ field: 'low', code: 'not-positive' }],
    });
  });

  it('refuses a value above the highest the app can store', () => {
    expect(read('', '100000000')).toEqual({
      status: 'invalid',
      errors: [{ field: 'high', code: 'too-big' }],
    });
  });

  it('refuses a value below a floor that is not merely "positive"', () => {
    expect(read('50', '', { limits: { minValue: 100, maxValue: 5000 } })).toEqual({
      status: 'invalid',
      errors: [{ field: 'low', code: 'too-small' }],
    });
  });

  it('accepts a negative value only where the type allows one (net fluid balance)', () => {
    expect(read('-500', '')).toEqual({
      status: 'invalid',
      errors: [{ field: 'low', code: 'not-positive' }],
    });
    expect(read('-500', '', { limits: SIGNED })).toEqual({
      status: 'valid',
      lowValue: '-500',
      highValue: null,
    });
  });

  /** Some keyboards substitute a typographic minus or dash; it means the same thing. */
  it.each(['\u2212500', '\u2013500'])('reads %p as a minus sign', (text) => {
    expect(read(text, '', { limits: SIGNED })).toMatchObject({ status: 'valid', lowValue: '-500' });
  });

  it('reads thousands separators, and only where they group thousands', () => {
    expect(read('1,500', '')).toMatchObject({ status: 'valid', lowValue: '1500' });
    expect(read('15,00', '').status).toBe('invalid');
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

describe('toEditableText', () => {
  it('gives back what the patient can save again, at the column scale', () => {
    expect(toEditableText(591.4706, 'imperial')).toBe('20');
    expect(toEditableText(1500.25, 'metric')).toBe('1500.25');
    expect(toEditableText(null, 'metric')).toBe('');
  });

  /** Pre-filled and saved unchanged, it must store what was there. */
  it('round-trips through the form', () => {
    const text = toEditableText(591.4706, 'imperial');
    expect(read(text, '', { measurementSystem: 'imperial' })).toMatchObject({
      lowValue: '591.4706',
    });
  });
});
