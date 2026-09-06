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
  convertVolumeForDisplay,
  convertWeightForDisplay,
  formatDailyVolumeTotalForDisplay,
  kgToLb,
  lbToKg,
  mlToOz,
  ozToMl,
  sumCanonicalVolumesMl,
} from './index.js';

describe('volume conversion round-trips (ADR-0004)', () => {
  it('mL -> oz -> mL round-trips within floating-point tolerance', () => {
    const startMl = 236.5882365;
    expect(ozToMl(mlToOz(startMl))).toBeCloseTo(startMl, 6);
  });

  it('oz -> mL -> oz round-trips within floating-point tolerance', () => {
    const startOz = 8;
    expect(mlToOz(ozToMl(startOz))).toBeCloseTo(startOz, 6);
  });
});

describe('weight conversion round-trips', () => {
  it('kg -> lb -> kg round-trips within floating-point tolerance', () => {
    const startKg = 70.5;
    expect(lbToKg(kgToLb(startKg))).toBeCloseTo(startKg, 6);
  });

  it('lb -> kg -> lb round-trips within floating-point tolerance', () => {
    const startLb = 155.4;
    expect(kgToLb(lbToKg(startLb))).toBeCloseTo(startLb, 6);
  });
});

describe('AC 2.1 AC4 — conversion rounding', () => {
  it('metric display preserves entered precision — no rounding within the same system', () => {
    expect(convertVolumeForDisplay(118.294, 'metric')).toEqual({ value: 118.294, unit: 'mL' });
  });

  it('imperial display rounds a cross-system conversion to the nearest whole ounce', () => {
    const eightOzInMl = 8 * 29.5735295625;
    expect(convertVolumeForDisplay(eightOzInMl, 'imperial')).toEqual({ value: 8, unit: 'oz' });
  });

  it('never leaves an imperial reading coarser-than-mL noise visible: 236.588 mL reads as 8 oz, not 236.588 mL', () => {
    expect(convertVolumeForDisplay(236.588, 'imperial').value).toBe(8);
  });
});

describe('AC 2.1 AC4 — the weight carve-out', () => {
  it('metric display rounds to one decimal place, never to a whole unit', () => {
    expect(convertWeightForDisplay(70.94, 'metric')).toEqual({ value: 70.9, unit: 'kg' });
  });

  it('imperial display also rounds to one decimal place, never to a whole unit', () => {
    expect(convertWeightForDisplay(68, 'imperial')).toEqual({ value: 149.9, unit: 'lb' });
  });

  it('preserves a sub-kilogram day-over-day change that whole-unit rounding would destroy — the reason the carve-out exists (SRS §3.12)', () => {
    const dayOne = convertWeightForDisplay(70.4, 'metric');
    const dayTwo = convertWeightForDisplay(69.5, 'metric'); // a real, clinically meaningful overnight drop
    expect(dayOne.value - dayTwo.value).toBeCloseTo(0.9, 5);

    // What whole-unit rounding — the volume rule, misapplied to weight —
    // would have done to these same two readings: both collapse to the
    // same whole kilogram, and the drop vanishes entirely.
    expect(Math.round(70.4)).toBe(Math.round(69.5));
  });
});

describe('daily totals are computed from canonical values and rounded once (CLAUDE.md)', () => {
  it('sums exact canonical values with no rounding', () => {
    expect(
      sumCanonicalVolumesMl([
        { value: 100.1, unit: 'mL' },
        { value: 100.2, unit: 'mL' },
      ]),
    ).toBeCloseTo(200.3, 6);
  });

  it('rounds the total once, rather than summing already-rounded per-entry display figures', () => {
    const entries = [
      { value: 100, unit: 'mL' as const },
      { value: 100, unit: 'mL' as const },
      { value: 100, unit: 'mL' as const },
    ];

    const correctTotal = formatDailyVolumeTotalForDisplay(entries, 'imperial');
    const wrongBySummingRoundedParts = entries.reduce(
      (total, entry) => total + convertVolumeForDisplay(entry.value, 'imperial').value,
      0,
    );

    // 300 mL total converts to ~10.14 oz, correctly rounding to 10 oz.
    expect(correctTotal).toEqual({ value: 10, unit: 'oz' });
    // Each 100 mL entry individually rounds down to 3 oz (~3.38 oz truncated
    // by rounding), so summing the already-rounded parts silently loses a
    // whole ounce across the day.
    expect(wrongBySummingRoundedParts).toBe(9);
    expect(correctTotal.value).not.toBe(wrongBySummingRoundedParts);
  });
});
