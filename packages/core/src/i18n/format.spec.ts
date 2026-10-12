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
  formatVolumeUnitLabel,
  formatWeightQuantity,
  formatWeightUnitLabel,
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
  /**
   * The bare unit label, for an input's suffix.
   *
   * The imperial case is the one that matters and the reason these exist: the
   * `VolumeUnit` token is `'oz'`, CLDR's short form is `'fl oz'`, and a volume
   * labelled in a unit most readers know as a measure of weight is ambiguous
   * in the one place a patient is typing a clinical number. The metric pair is
   * asserted beside it because token and label coincide there — which is what
   * hid the imperial case for as long as metric was the only reachable system.
   */
  it('formats a volume unit label on its own, with no number', () => {
    expect(formatVolumeUnitLabel('mL', DEFAULT_LOCALE, 'short')).toBe('mL');
    expect(formatVolumeUnitLabel('oz', DEFAULT_LOCALE, 'short')).toBe('fl oz');
  });

  it('formats a weight unit label on its own', () => {
    expect(formatWeightUnitLabel('kg', DEFAULT_LOCALE, 'short')).toBe('kg');
    expect(formatWeightUnitLabel('lb', DEFAULT_LOCALE, 'short')).toBe('lb');
  });

  /**
   * The same accessible-name rule as the quantity formatters: "fl oz" is read
   * out as letters.
   *
   * Singular, because a label names the unit rather than counting anything —
   * the field it sits beside has no value yet.
   */
  it('spells a unit label out when the long form is asked for', () => {
    expect(formatVolumeUnitLabel('oz', DEFAULT_LOCALE, 'long')).toBe('fluid ounce');
    expect(formatWeightUnitLabel('kg', DEFAULT_LOCALE, 'long')).toBe('kilogram');
  });

  /** A label is a label: the sample number must not survive the subtraction. */
  it('never leaks the sample number into the label', () => {
    for (const label of [
      formatVolumeUnitLabel('mL', DEFAULT_LOCALE, 'short'),
      formatVolumeUnitLabel('oz', DEFAULT_LOCALE, 'short'),
      formatWeightUnitLabel('kg', DEFAULT_LOCALE, 'short'),
      formatWeightUnitLabel('lb', DEFAULT_LOCALE, 'short'),
    ]) {
      expect(label).not.toMatch(/\d/);
    }
  });
  /**
   * The label stays honest in a locale whose own ounce is a different size.
   *
   * `../units` converts with the US fluid ounce, and CLDR's `fluid-ounce`
   * identifier means exactly that one — so a reader in a locale where "fl oz"
   * would otherwise mean the imperial ounce (28.4131 mL, about 4% smaller)
   * gets a disambiguated label instead of a wrong one. Pinned because review
   * assumed the opposite: that `en-GB` would silently relabel US-ounce numbers
   * with the UK name. It does not, and the next person to wonder should find
   * the measurement rather than repeat the guess.
   */
  it('disambiguates the ounce in a locale that has its own', () => {
    expect(formatVolumeUnitLabel('oz', 'en-US', 'short')).toBe('fl oz');
    expect(formatVolumeUnitLabel('oz', 'en-GB', 'short')).toBe('US fl oz');
  });
});
