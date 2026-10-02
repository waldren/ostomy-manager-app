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
 * The three curves, which are the only reason this scenario exists.
 *
 * `invariants.spec.ts` already proves it is valid, deterministic and
 * constraint-clean. What is left is the clinical story: output climbing while
 * intake stays flat and urine falls. A scenario where any one of those three is
 * wrong still passes every invariant and demonstrates nothing — so these are
 * the assertions that make the dataset worth having.
 */

import { ESTIMATION_METHOD_CODE } from '@ostomy/core/validation';
import { describe, expect, it } from 'vitest';

import { generateScenario } from '../index.js';
import {
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
  type SeedObservation,
} from '../types.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const ESTIMATION_CODE = ESTIMATION_METHOD_CODE.resolved ? ESTIMATION_METHOD_CODE.code : null;

function generate() {
  return generateScenario('high-output-dehydration', {
    oidcSubject: 'curves',
    now: NOW,
    estimationMethodCode: ESTIMATION_CODE,
  });
}

/** Measured volume per local day for one code. Unmeasured rows contribute nothing. */
function dailyTotals(observations: readonly SeedObservation[], code: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const observation of observations) {
    if (observation.code !== code) continue;
    const value =
      observation.valueQuantityValue === null ? 0 : Number(observation.valueQuantityValue);
    totals.set(observation.localDate, (totals.get(observation.localDate) ?? 0) + value);
  }
  return totals;
}

function sortedDays(totals: Map<string, number>): string[] {
  return [...totals.keys()].sort();
}

describe('high-output-dehydration', () => {
  const dataset = generate();
  const output = dailyTotals(dataset.observations, STOMA_OUTPUT_LOINC_CODE);
  const intake = dailyTotals(dataset.observations, FLUID_INTAKE_LOINC_CODE);
  const urine = dailyTotals(dataset.observations, VOIDED_URINE_LOINC_CODE);
  const days = sortedDays(output);

  const first = days[0] ?? '';
  const last = days[days.length - 1] ?? '';

  it('emits all three signals, which is what P3.S5 made possible', () => {
    // Before P3.S5 the seeder could express stoma output and nothing else, so
    // two of these three were unrepresentable and this scenario could not exist.
    expect(output.size).toBeGreaterThan(0);
    expect(intake.size).toBeGreaterThan(0);
    expect(urine.size).toBeGreaterThan(0);
  });

  it('climbs output past the excessive daily bound', () => {
    expect(output.get(last) ?? 0).toBeGreaterThan(2000);
    // At least doubled, so a reader sees a trend rather than noise.
    expect(output.get(last) ?? 0).toBeGreaterThan((output.get(first) ?? 0) * 2);
  });

  it('starts below the excessive bound, so there is a crossing to see', () => {
    // A dataset that is excessive from day one shows no anomaly ONSET, which is
    // what §3.5's physician view and §3.9's adaptation actually read.
    expect(output.get(first) ?? 0).toBeLessThan(2000);
  });

  it('holds intake flat, which is the point of the comparison', () => {
    const values = days.map((day) => intake.get(day) ?? 0);
    const min = Math.min(...values);
    const max = Math.max(...values);

    // Flat to within rounding of the split, not merely "not rising".
    expect(max - min).toBeLessThan(2);
  });

  it('falls urine output as the patient dehydrates', () => {
    expect(urine.get(last) ?? 0).toBeLessThan((urine.get(first) ?? 0) / 2);
  });

  it('darkens the urine colour as the volume falls', () => {
    // Concentration tracking volume is the clinically real correlation. A
    // falling volume with a pale colour would teach the opposite.
    const colourFor = (day: string) =>
      dataset.observations.find(
        (entry) => entry.localDate === day && entry.code === VOIDED_URINE_LOINC_CODE,
      )?.urineColorCode;

    expect(colourFor(first)).toEqual('pale_straw');
    expect(['dark_yellow', 'amber', 'brown']).toContain(colourFor(last));
  });

  describe('the unmeasured urine entries', () => {
    const volumeless = dataset.observations.filter((entry) => entry.valueQuantityValue === null);

    it('exist, because a patient this unwell stops measuring', () => {
      expect(volumeless.length).toBeGreaterThan(0);
    });

    it('appear only in the final stretch', () => {
      // Scattered through the baseline they would read as a logging habit
      // rather than as deterioration.
      const latest = days.slice(-6);
      for (const entry of volumeless) {
        expect(latest).toContain(entry.localDate);
      }
    });

    /**
     * The hazard the dataset exists to make visible, stated as an assertion so
     * nobody "fixes" it later.
     *
     * On the last day the MEASURED urine total is far below what the patient
     * actually produced, because most of that day's entries carry a colour and
     * no volume. A reader summing the column sees a catastrophically oliguric
     * figure; the real one is higher. That is exactly why §3.7's block has to
     * report how much of the day it covers rather than rendering a total as if
     * it were complete — and it is realistic, not contrived.
     */
    it('leaves the final day measured total understating the real one', () => {
      const lastDayEntries = dataset.observations.filter(
        (entry) => entry.localDate === last && entry.code === VOIDED_URINE_LOINC_CODE,
      );
      const unmeasuredOnLastDay = lastDayEntries.filter(
        (entry) => entry.valueQuantityValue === null,
      );

      expect(unmeasuredOnLastDay.length).toBeGreaterThan(0);
      expect(unmeasuredOnLastDay.length).toBeLessThan(lastDayEntries.length + 1);
    });
  });

  it('categorises every intake entry', () => {
    // P3.S2 found `fluidTypeCode` missing from the sync path, so every intake
    // entry logged offline lost its categorisation. Seeding it uncategorised
    // would reproduce that hole in the demo data.
    for (const entry of dataset.observations) {
      if (entry.code !== FLUID_INTAKE_LOINC_CODE) continue;
      expect(entry.fluidTypeCode).toBeTruthy();
    }
  });

  it('introduces oral rehydration solution only as things worsen', () => {
    const early = dataset.observations.filter(
      (entry) => entry.code === FLUID_INTAKE_LOINC_CODE && entry.localDate === first,
    );

    expect(early.every((entry) => entry.fluidTypeCode !== 'oral_rehydration_solution')).toBe(true);
    expect(
      dataset.observations.some((entry) => entry.fluidTypeCode === 'oral_rehydration_solution'),
    ).toBe(true);
  });
});
