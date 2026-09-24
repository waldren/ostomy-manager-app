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

import { convertVolumeForDisplay, unitsForMeasurementSystem } from '../units/index.js';
import {
  BODY_WEIGHT_LOINC_CODE,
  FLUID_INTAKE_LOINC_CODE,
  RESTING_HEART_RATE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
  // LOINC literals are module-internal to `hydration` (S9) — this spec
  // imports them directly from the sibling module rather than through
  // `./index.js`, which deliberately does not re-export them.
} from './loincCodes.js';
import {
  countsTowardDailyNetFluidBalance,
  DAILY_NET_FLUID_BALANCE_LOINC_CODES,
  isUrineOutputSignal,
  netDailyFluidBalanceMl,
  URINE_OUTPUT_LOINC_CODES,
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

  it('a voided-urine observation never contributes to the balance, even mixed in with everything else', () => {
    const balance = netDailyFluidBalanceMl([
      { loincCode: STOMA_OUTPUT_LOINC_CODE, valueMl: 300 },
      { loincCode: FLUID_INTAKE_LOINC_CODE, valueMl: 500 },
      // Deliberately large — if this were ever wrongly summed in, it would
      // dominate the balance and mask a normal-looking balance hiding a
      // dangerously low urine output (CLAUDE.md, SRS §3.7).
      { loincCode: VOIDED_URINE_LOINC_CODE, valueMl: 999_999 },
    ]);

    // SRS §3.5: total fluid intake MINUS total stoma output. 500 mL intake
    // minus 300 mL output is a +200 mL day, not the +800 mL an
    // (intake + output) sum would wrongly produce.
    expect(balance).toBe(200);
  });

  it('the include-set is exactly stoma output and fluid intake, not "everything except urine"', () => {
    expect([...DAILY_NET_FLUID_BALANCE_LOINC_CODES].sort()).toEqual(
      [STOMA_OUTPUT_LOINC_CODE, FLUID_INTAKE_LOINC_CODE].sort(),
    );
  });

  it('an output-dominant day is a NEGATIVE balance — the classic dehydration presentation (SRS §3.5)', () => {
    // 2,000 mL of stoma output against only 500 mL of intake is a real,
    // clinically urgent -1,500 mL day. A caller that mistakenly summed
    // instead of subtracted would report a reassuring +2,500 mL — the
    // sicker the patient, the healthier the number.
    const balance = netDailyFluidBalanceMl([
      { loincCode: STOMA_OUTPUT_LOINC_CODE, valueMl: 2000 },
      { loincCode: FLUID_INTAKE_LOINC_CODE, valueMl: 500 },
    ]);

    expect(balance).toBe(-1500);
  });

  it('output only, no intake recorded, is still a negative balance', () => {
    const balance = netDailyFluidBalanceMl([{ loincCode: STOMA_OUTPUT_LOINC_CODE, valueMl: 400 }]);

    expect(balance).toBe(-400);
  });
});

/**
 * Urine as a signal in its own right, which is the other half of excluding
 * it from the balance (SRS §3.7, CLAUDE.md's four hydration signals).
 *
 * A UI that shows urine separately has to pick those observations out, and
 * without a named predicate here it would reach for the raw LOINC code —
 * making some screen a second terminology entry point ahead of
 * `packages/core/src/fhir` (ADR-0007).
 */
describe('urine output as its own hydration signal', () => {
  it('recognises voided urine and nothing else', () => {
    expect(isUrineOutputSignal(VOIDED_URINE_LOINC_CODE)).toBe(true);
    for (const other of [
      STOMA_OUTPUT_LOINC_CODE,
      FLUID_INTAKE_LOINC_CODE,
      BODY_WEIGHT_LOINC_CODE,
      RESTING_HEART_RATE_LOINC_CODE,
    ]) {
      expect(isUrineOutputSignal(other)).toBe(false);
    }
  });

  /**
   * The two facts must not drift: a code that is the urine signal is a code
   * the balance excludes. Asserted as a relationship rather than as two
   * literal lists, so adding a urine code to one set and forgetting the
   * other fails here.
   */
  it('is disjoint from everything the balance counts', () => {
    for (const code of URINE_OUTPUT_LOINC_CODES) {
      expect(countsTowardDailyNetFluidBalance(code)).toBe(false);
    }
  });

  it('contributes nothing to the balance, in either direction, at any volume', () => {
    const base = netDailyFluidBalanceMl([
      { loincCode: FLUID_INTAKE_LOINC_CODE, valueMl: 2000 },
      { loincCode: STOMA_OUTPUT_LOINC_CODE, valueMl: 1400 },
    ]);
    const withUrine = netDailyFluidBalanceMl([
      { loincCode: FLUID_INTAKE_LOINC_CODE, valueMl: 2000 },
      { loincCode: STOMA_OUTPUT_LOINC_CODE, valueMl: 1400 },
      { loincCode: VOIDED_URINE_LOINC_CODE, valueMl: 1800 },
    ]);

    expect(base).toBe(600);
    expect(withUrine).toBe(base);
  });
});

describe('daily totals are computed from canonical values and rounded once (CLAUDE.md)', () => {
  it('rounding the canonical balance once differs from summing individually rounded display figures', () => {
    const metric = unitsForMeasurementSystem('metric');
    const imperial = unitsForMeasurementSystem('imperial');

    // All intake, no output, so the balance is a plain sum for this test's
    // purposes — the point under test is rounding-once vs.
    // summing-already-rounded-parts, not the intake/output subtraction.
    const observations = [
      { loincCode: FLUID_INTAKE_LOINC_CODE, valueMl: 100 },
      { loincCode: FLUID_INTAKE_LOINC_CODE, valueMl: 100 },
      { loincCode: FLUID_INTAKE_LOINC_CODE, valueMl: 100 },
    ];

    const canonicalBalanceMl = netDailyFluidBalanceMl(observations);
    // Entered in metric, displayed in imperial — a genuine cross-system
    // conversion, which is where AC 2.1 AC4's whole-unit rounding applies.
    const correctDisplayedTotal = convertVolumeForDisplay(canonicalBalanceMl, metric, imperial);

    const summedFromRoundedParts = observations.reduce(
      (total, observation) =>
        total + convertVolumeForDisplay(observation.valueMl, metric, imperial).value,
      0,
    );

    expect(correctDisplayedTotal).toEqual({ value: 10, unit: 'oz' });
    expect(summedFromRoundedParts).toBe(9);
    expect(correctDisplayedTotal.value).not.toBe(summedFromRoundedParts);
  });
});
