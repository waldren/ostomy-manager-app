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
  unitsForMeasurementSystem,
} from './index.js';

const metric = unitsForMeasurementSystem('metric');
const imperial = unitsForMeasurementSystem('imperial');

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

describe('AC 2.1 AC4 — conversion rounding depends on entry system vs. target system (B2)', () => {
  it('same-system readback preserves entered precision — no rounding, even though it is an "imperial" display', () => {
    // Entered as 8.5 oz, stored as canonical mL, displayed back in
    // imperial: this is NOT a conversion, it is a readback, and must not
    // round 8.5 to 9 (the exact defect this parameter fixes).
    const enteredOz = 8.5;
    const canonicalMl = ozToMl(enteredOz);
    expect(convertVolumeForDisplay(canonicalMl, imperial, imperial).value).toBeCloseTo(
      enteredOz,
      6,
    );
  });

  it('metric display preserves entered precision — no rounding within the same system', () => {
    expect(convertVolumeForDisplay(118.294, metric, metric)).toEqual({
      value: 118.294,
      unit: 'mL',
    });
  });

  it('a value entered in mL and displayed in mL is never rounded, regardless of magnitude', () => {
    expect(convertVolumeForDisplay(236.588, metric, metric).value).toBe(236.588);
  });

  it('cross-system conversion (entered metric, displayed imperial) rounds to the nearest whole ounce', () => {
    const eightOzInMl = 8 * 29.5735295625;
    expect(convertVolumeForDisplay(eightOzInMl, metric, imperial)).toEqual({
      value: 8,
      unit: 'oz',
    });
  });

  it('cross-system conversion (entered imperial, displayed metric) rounds to the nearest whole millilitre — 8 oz entered renders as a clean 237 mL, not 236.588 mL', () => {
    const eightOzInMl = ozToMl(8);
    expect(convertVolumeForDisplay(eightOzInMl, imperial, metric)).toEqual({
      value: 237,
      unit: 'mL',
    });
  });

  it('never leaves cross-system noise visible: 236.588 mL entered in metric reads as a clean 8 oz when displayed in imperial', () => {
    expect(convertVolumeForDisplay(236.588, metric, imperial).value).toBe(8);
  });
});

describe('AC 2.1 AC4 — the weight carve-out (weight rounds to one decimal in both systems, no entry-system branch)', () => {
  it('metric display rounds to one decimal place, never to a whole unit', () => {
    expect(convertWeightForDisplay(70.94, metric)).toEqual({ value: 70.9, unit: 'kg' });
  });

  it('imperial display also rounds to one decimal place, never to a whole unit', () => {
    expect(convertWeightForDisplay(68, imperial)).toEqual({ value: 149.9, unit: 'lb' });
  });

  it('preserves a sub-kilogram day-over-day change that whole-unit rounding would destroy — the reason the carve-out exists (SRS §3.12)', () => {
    const dayOne = convertWeightForDisplay(70.4, metric);
    const dayTwo = convertWeightForDisplay(69.5, metric); // a real, clinically meaningful overnight drop
    expect(dayOne.value - dayTwo.value).toBeCloseTo(0.9, 5);

    // What whole-unit rounding — the volume rule, misapplied to weight —
    // would have done to these same two readings: both collapse to the
    // same whole kilogram, and the drop vanishes entirely.
    expect(Math.round(70.4)).toBe(Math.round(69.5));
  });
});

describe('S3 — rounding is round-half-away-from-zero, not native Math.round, and normalises -0', () => {
  it('rounds a negative cross-system conversion away from zero, not toward it', () => {
    // -2.5 oz worth of canonical mL, displayed in a different system than
    // entered (a genuine cross-system conversion, so rounding applies).
    // Math.round(-2.5) === -2 (biased toward zero, i.e. toward looking
    // less dehydrated); round-half-away-from-zero must give -3.
    const negativeTwoPointFiveOzInMl = ozToMl(-2.5);
    expect(convertVolumeForDisplay(negativeTwoPointFiveOzInMl, metric, imperial).value).toBe(-3);
  });

  it('never renders a literal "-0" for a value that rounds to zero', () => {
    // A tiny negative canonical value that rounds to zero ounces on
    // cross-system display must render as 0, not -0.
    const tinyNegativeMl = ozToMl(-0.4);
    const displayed = convertVolumeForDisplay(tinyNegativeMl, metric, imperial);
    expect(displayed.value).toBe(0);
    expect(Object.is(displayed.value, -0)).toBe(false);
  });

  it('weight rounding also normalises -0 rather than propagating it', () => {
    expect(Object.is(convertWeightForDisplay(-0.001, metric).value, -0)).toBe(false);
    expect(convertWeightForDisplay(-0.001, metric).value).toBe(0);
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

    const correctTotal = formatDailyVolumeTotalForDisplay(entries, metric, imperial);
    const wrongBySummingRoundedParts = entries.reduce(
      (total, entry) => total + convertVolumeForDisplay(entry.value, metric, imperial).value,
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
