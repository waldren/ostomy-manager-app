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

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCALE,
  formatDateTime,
  formatNumber,
  formatVolumeQuantity,
  formatWeightQuantity,
} from './index.js';

describe('Intl-based formatting helpers (ADR-0006)', () => {
  it('formats a volume quantity with its unit, short form by default', () => {
    expect(formatVolumeQuantity({ value: 350, unit: 'mL' })).toBe('350 mL');
    expect(formatVolumeQuantity({ value: 8, unit: 'oz' })).toBe('8 fl oz');
  });

  it('formats a volume quantity with its long, screen-reader-friendly unit name on request (S2)', () => {
    expect(formatVolumeQuantity({ value: 350, unit: 'mL' }, DEFAULT_LOCALE, 'long')).toBe(
      '350 milliliters',
    );
    expect(formatVolumeQuantity({ value: 8, unit: 'oz' }, DEFAULT_LOCALE, 'long')).toBe(
      '8 fluid ounces',
    );
  });

  it('formats a weight quantity to one decimal place with its unit, short form by default', () => {
    expect(formatWeightQuantity({ value: 70.9, unit: 'kg' })).toBe('70.9 kg');
  });

  it('formats a weight quantity with its long, screen-reader-friendly unit name on request (S2) — "70.9 kilograms", not "kg" read letter-by-letter', () => {
    expect(formatWeightQuantity({ value: 70.9, unit: 'kg' }, DEFAULT_LOCALE, 'long')).toBe(
      '70.9 kilograms',
    );
    expect(formatWeightQuantity({ value: 149.9, unit: 'lb' }, DEFAULT_LOCALE, 'long')).toBe(
      '149.9 pounds',
    );
  });

  it('is locale-aware: a different locale changes number formatting even though v1 ships only one', () => {
    // de-DE uses a comma as the decimal separator and a period as the
    // thousands separator — the opposite of en-US.
    expect(formatNumber(1234.5, 'de-DE')).toBe('1.234,5');
    expect(formatNumber(1234.5, DEFAULT_LOCALE)).toBe('1,234.5');
  });

  it('defaults to the v1 locale when none is supplied', () => {
    expect(formatNumber(1234.5)).toBe(formatNumber(1234.5, DEFAULT_LOCALE));
  });

  it('formats a date/time value with an explicit, fixed output (nits: not just typeof === "string")', () => {
    const value = new Date('2026-06-15T12:00:00.000Z');
    expect(formatDateTime(value)).toBe('Jun 15, 2026, 12:00 PM');
  });

  it('formats the same instant identically regardless of the host environment, via an explicit default time zone (nits)', () => {
    const value = new Date('2026-06-15T23:30:00.000Z');
    // Without an explicit default zone, this would render differently on
    // a UTC API host vs. a device in, say, America/Los_Angeles.
    expect(formatDateTime(value)).toBe('Jun 15, 2026, 11:30 PM');
  });

  it("accepts an explicit time zone override for a caller that needs the viewer's local zone", () => {
    const value = new Date('2026-06-15T23:30:00.000Z');
    expect(formatDateTime(value, DEFAULT_LOCALE, { timeZone: 'America/Los_Angeles' })).toBe(
      'Jun 15, 2026, 4:30 PM',
    );
  });
});
