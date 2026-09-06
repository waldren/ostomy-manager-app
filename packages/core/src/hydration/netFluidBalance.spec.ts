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

import { convertVolumeForDisplay } from '../units/index.js';
import {
  BODY_WEIGHT_LOINC_CODE,
  countsTowardDailyNetFluidBalance,
  DAILY_NET_FLUID_BALANCE_LOINC_CODES,
  FLUID_INTAKE_LOINC_CODE,
  RESTING_HEART_RATE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  sumDailyNetFluidBalanceMl,
  VOIDED_URINE_LOINC_CODE,
} from './index.js';

describe('Daily Net Fluid Balance classification (SRS §3.7)', () => {
  it('counts stoma output and fluid intake', () => {
    expect(countsTowardDailyNetFluidBalance(STOMA_OUTPUT_LOINC_CODE)).toBe(true);
    expect(countsTowardDailyNetFluidBalance(FLUID_INTAKE_LOINC_CODE)).toBe(true);
  });

  it('excludes voided urine on purpose', () => {
    expect(countsTowardDailyNetFluidBalance(VOIDED_URINE_LOINC_CODE)).toBe(false);
  });

  it('excludes weight and heart rate — not volumetric stoma/fluid signals at all', () => {
    expect(countsTowardDailyNetFluidBalance(BODY_WEIGHT_LOINC_CODE)).toBe(false);
    expect(countsTowardDailyNetFluidBalance(RESTING_HEART_RATE_LOINC_CODE)).toBe(false);
  });

  it('a voided-urine observation never contributes to the sum, even mixed in with everything else', () => {
    const total = sumDailyNetFluidBalanceMl([
      { loincCode: STOMA_OUTPUT_LOINC_CODE, valueMl: 300 },
      { loincCode: FLUID_INTAKE_LOINC_CODE, valueMl: 500 },
      // Deliberately large — if this were ever wrongly summed in, it would
      // dominate the total and mask a normal-looking balance hiding a
      // dangerously low urine output (CLAUDE.md, SRS §3.7).
      { loincCode: VOIDED_URINE_LOINC_CODE, valueMl: 999_999 },
    ]);

    expect(total).toBe(800);
  });

  it('the include-set is exactly stoma output and fluid intake, not "everything except urine"', () => {
    expect([...DAILY_NET_FLUID_BALANCE_LOINC_CODES].sort()).toEqual(
      [STOMA_OUTPUT_LOINC_CODE, FLUID_INTAKE_LOINC_CODE].sort(),
    );
  });
});

describe('daily totals are computed from canonical values and rounded once (CLAUDE.md)', () => {
  it('rounding the canonical total once differs from summing individually rounded display figures', () => {
    const observations = [
      { loincCode: STOMA_OUTPUT_LOINC_CODE, valueMl: 100 },
      { loincCode: STOMA_OUTPUT_LOINC_CODE, valueMl: 100 },
      { loincCode: STOMA_OUTPUT_LOINC_CODE, valueMl: 100 },
    ];

    const canonicalTotalMl = sumDailyNetFluidBalanceMl(observations);
    const correctDisplayedTotal = convertVolumeForDisplay(canonicalTotalMl, 'imperial');

    const summedFromRoundedParts = observations.reduce(
      (total, observation) =>
        total + convertVolumeForDisplay(observation.valueMl, 'imperial').value,
      0,
    );

    expect(correctDisplayedTotal).toEqual({ value: 10, unit: 'oz' });
    expect(summedFromRoundedParts).toBe(9);
    expect(correctDisplayedTotal.value).not.toBe(summedFromRoundedParts);
  });
});
