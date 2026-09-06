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
  it('formats a volume quantity with its unit', () => {
    expect(formatVolumeQuantity({ value: 350, unit: 'mL' })).toBe('350 mL');
  });

  it('formats a weight quantity to one decimal place with its unit', () => {
    expect(formatWeightQuantity({ value: 70.9, unit: 'kg' })).toBe('70.9 kg');
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

  it('formats a date/time value', () => {
    const value = new Date('2026-06-15T12:00:00.000Z');
    const formatted = formatDateTime(value);
    expect(typeof formatted).toBe('string');
    expect(formatted.length).toBeGreaterThan(0);
  });
});
