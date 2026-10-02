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

import { ESTIMATION_METHOD_CODE, MEASURED_METHOD_CODE } from '@ostomy/core/validation';
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
const MEASURED_CODE = MEASURED_METHOD_CODE.resolved ? MEASURED_METHOD_CODE.code : null;

function generate() {
  return generateScenario('high-output-dehydration', {
    oidcSubject: 'curves',
    now: NOW,
    estimationMethodCode: ESTIMATION_CODE,
    measuredMethodCode: MEASURED_CODE,
  });
}

/**
 * Measured volume per local day for one code. Unmeasured rows are skipped.
 *
 * `continue`, not `+ 0`, and the difference is the rule this file is about.
 * The first version scored a volumeless row as zero while its own docstring
 * said "contribute nothing" — arithmetically the same sum, but it created a map
 * entry of `0` for a day whose entries were all unmeasured, which is `0 mL` as
 * an invented reading in the most alarming possible direction for this signal.
 * This is the helper someone copies the next time they total urine for a real
 * dashboard.
 */
function dailyTotals(observations: readonly SeedObservation[], code: string): Map<string, number> {
  const totals = new Map<string, number>();
  for (const observation of observations) {
    if (observation.code !== code) continue;
    if (observation.valueQuantityValue === null) continue;
    const value = Number(observation.valueQuantityValue);
    totals.set(observation.localDate, (totals.get(observation.localDate) ?? 0) + value);
  }
  return totals;
}

/** Mean measured volume of a single entry on one local day, for one code. */
function meanEntryVolumeOn(
  observations: readonly SeedObservation[],
  code: string,
  day: string,
): number {
  const volumes = observations
    .filter(
      (entry) =>
        entry.code === code && entry.localDate === day && entry.valueQuantityValue !== null,
    )
    .map((entry) => Number(entry.valueQuantityValue));

  return volumes.reduce((running, value) => running + value, 0) / volumes.length;
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

  /**
   * 2,000 mL is `stoma_output_single_entry_warning_ml`'s seeded value, which is
   * a SINGLE-ENTRY rule (SRS §3.8). No daily excessive bound exists anywhere
   * yet — `clinical_default_ranges` has no seeded rows — so this is a clinical
   * sanity check on the daily total, not a check against a configured bound.
   * The test name said "the excessive daily bound", which claimed more than it
   * can.
   */
  it('climbs the daily output total past 2,000 mL', () => {
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
    const firstWeek = values.slice(0, 7);
    const lastWeek = values.slice(-7);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

    /**
     * No upward trend, rather than flat to within 2 mL.
     *
     * The old assertion was literally true and clinically absurd: a 45-day
     * intake line identical to the millilitre is not something a human
     * produces, and review flagged it as making the chart look synthetic. The
     * claim the scenario actually needs is that intake does not rise to meet
     * the losses — which is what this checks, against jitter.
     */
    expect(mean(lastWeek)).toBeLessThan(mean(firstWeek) * 1.1);
    expect(mean(lastWeek)).toBeGreaterThan(mean(firstWeek) * 0.9);
  });

  /**
   * Per MEASURED ENTRY, not per daily total — and review proved the daily form
   * could not fail.
   *
   * Two mutations passed 11/11 against the old assertion: setting
   * `URINE_ML_PER_DAY_WORST` to the baseline (a completely flat curve), and
   * replacing the lerp outright. The daily total on the final days is depressed
   * by the colour-only entries alone, which contributed nothing to the sum, so
   * `< first / 2` cleared without any decline in the volumes — satisfied by the
   * unmeasured-row artifact rather than by the thing being modelled.
   *
   * A rate per measured entry is immune to that: however many entries carry no
   * volume, the ones that do must get smaller.
   */
  it('falls urine volume per measured entry as the patient dehydrates', () => {
    const firstDay = meanEntryVolumeOn(dataset.observations, VOIDED_URINE_LOINC_CODE, first);
    const lastDay = meanEntryVolumeOn(dataset.observations, VOIDED_URINE_LOINC_CODE, last);

    expect(lastDay).toBeLessThan(firstDay / 2);
  });

  it('also falls as a measured daily total', () => {
    // Kept, because it is what a reader of the chart sees — but it is no longer
    // the only evidence for the curve.
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

      // Some unmeasured, and some NOT — a partial day rather than an empty one.
      //
      // `toBeLessThan(length + 1)` is what this said, which is a tautology: a
      // filtered subset's length is always at most the parent's, so it could
      // never fail for any generator. Both reviews caught it independently, and
      // it was the only thing standing behind the test's name.
      expect(unmeasuredOnLastDay.length).toBeGreaterThan(0);
      expect(unmeasuredOnLastDay.length).toBeLessThan(lastDayEntries.length);

      // And the claim the name actually makes: the measured total is below what
      // the modelled day produced, because part of it was never measured.
      expect(urine.get(last) ?? 0).toBeLessThan(450);
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
