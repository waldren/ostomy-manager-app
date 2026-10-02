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

/**
 * Warnings on one side of the line, clean entries on the other.
 *
 * `invariants.spec.ts` already asserts the load-bearing half — that this is the
 * only scenario tripping Tier 2, and that it still passes Tier 1 everywhere.
 * What remains is that the dataset shows the threshold as a *boundary* rather
 * than as a thing that fires on everything, and that it is injected rather than
 * hardcoded.
 */

import { ESTIMATION_METHOD_CODE, MEASURED_METHOD_CODE } from '@ostomy/core/validation';
import type { VolumetricValidationThresholds } from '@ostomy/core/validation';
import { describe, expect, it } from 'vitest';

import { findTier1Problems, findTier2Warnings, generateScenario } from '../index.js';
import { STOMA_OUTPUT_LOINC_CODE, VOIDED_URINE_LOINC_CODE } from '../types.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const ESTIMATION_CODE = ESTIMATION_METHOD_CODE.resolved ? ESTIMATION_METHOD_CODE.code : null;
const MEASURED_CODE = MEASURED_METHOD_CODE.resolved ? MEASURED_METHOD_CODE.code : null;

const SEEDED: VolumetricValidationThresholds = { softWarningMaxMl: 2000, maxClockSkewMs: 300_000 };

function generate() {
  return generateScenario('validation-edge-cases', {
    oidcSubject: 'edges',
    now: NOW,
    estimationMethodCode: ESTIMATION_CODE,
    measuredMethodCode: MEASURED_CODE,
  });
}

describe('validation-edge-cases', () => {
  const dataset = generate();
  const outputValues = dataset.observations
    .filter((entry) => entry.code === STOMA_OUTPUT_LOINC_CODE && entry.valueQuantityValue !== null)
    .map((entry) => Number(entry.valueQuantityValue));

  it('carries entries above the seeded soft-warning bound', () => {
    expect(outputValues.some((value) => value > SEEDED.softWarningMaxMl)).toBe(true);
  });

  it('carries entries just below it, so the bound reads as a boundary', () => {
    // A dataset of nothing but warnings looks identical to a system that warns
    // on everything — which is the failure #93's settable floor exists to
    // prevent. The just-under entries are what make the line visible.
    expect(outputValues.some((value) => value > 1500 && value < SEEDED.softWarningMaxMl)).toBe(
      true,
    );
  });

  it('keeps most entries ordinary, so the unusual ones stand out', () => {
    const unusual = outputValues.filter((value) => value > 1500).length;

    expect(unusual).toBeLessThan(outputValues.length / 2);
  });

  it('respects #93 settable ceiling, so a bound can still be configured around it', () => {
    // Above 3,000 mL an admin could not set a warning bound at all, and the
    // right tool for a physically implausible single entry is Tier 1 anyway.
    for (const value of outputValues) {
      expect(value).toBeLessThan(3000);
    }
  });

  /**
   * The threshold is injected, not hardcoded, so raising it must silence the
   * warnings rather than break the scenario. That is the ADR-0009 property
   * applied to this dataset specifically — and the check that would catch a
   * future version asserting a literal 2,000 somewhere.
   */
  it('stops warning when the bound is raised above its values', () => {
    const generous: VolumetricValidationThresholds = {
      softWarningMaxMl: 5000,
      maxClockSkewMs: 300_000,
    };

    expect(findTier2Warnings(dataset, SEEDED, NOW).length).toBeGreaterThan(0);
    expect(findTier2Warnings(dataset, generous, NOW)).toEqual([]);
    // And still valid, because Tier 1 does not depend on that bound.
    expect(findTier1Problems(dataset, generous, NOW)).toEqual([]);
  });

  it('warns more as the bound is tightened, without ever blocking', () => {
    // SRS §3.8: a warning never becomes a block. Tightening the bound must move
    // rows into Tier 2 and never into Tier 1.
    const tight: VolumetricValidationThresholds = {
      softWarningMaxMl: 1000,
      maxClockSkewMs: 300_000,
    };

    expect(findTier2Warnings(dataset, tight, NOW).length).toBeGreaterThan(
      findTier2Warnings(dataset, SEEDED, NOW).length,
    );
    expect(findTier1Problems(dataset, tight, NOW)).toEqual([]);
  });

  it('includes a value at the exact scale the canonical column allows', () => {
    // Four fractional digits is the most DECIMAL(12,4) holds; one more is
    // VALUE_EXCEEDS_MAX_PRECISION, a Tier 1 block. This is the shape an
    // un-rounded imperial conversion produces — ozToMl(80) is 2365.882365.
    expect(outputValues.some((value) => value === 1234.5678)).toBe(true);
  });

  it('includes a voided-urine entry with a colour and no volume', () => {
    // The only observation this system stores with no `valueQuantity`, and it
    // has its own rule set. This is the dataset someone reaches for when
    // testing validation behaviour, so the volumeless path belongs in it.
    const volumeless = dataset.observations.filter((entry) => entry.valueQuantityValue === null);

    expect(volumeless).toHaveLength(1);
    expect(volumeless[0]?.code).toEqual(VOIDED_URINE_LOINC_CODE);
    expect(volumeless[0]?.urineColorCode).toBeTruthy();
    expect(volumeless[0]?.method).toBeNull();
  });

  it('marks every unusual entry measured, not estimated', () => {
    // An estimated qualifier on a 2,500 mL entry invites the reading that the
    // warning fired because the number was guessed. §3.8's position is that a
    // real 2,500 mL day is the data point the care team most needs, so the
    // warning must be about the value rather than its provenance.
    //
    // Asserted against |Measured| rather than against null: ADR-0018 as amended
    // makes `null` mean "no toggle applies", so the first version of this test
    // was requiring the generator to produce a shape the application cannot.
    for (const entry of dataset.observations) {
      if (entry.code !== STOMA_OUTPUT_LOINC_CODE) continue;
      expect(entry.method).toEqual(MEASURED_CODE);
    }
  });
});
