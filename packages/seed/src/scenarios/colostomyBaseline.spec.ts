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
 * The ratio against the ileostomy baseline, which is the only thing this
 * scenario is for.
 *
 * `clinical_default_ranges` is keyed on `ostomy_type`, and with only
 * `stable-ileostomy` seeded nothing in this repository demonstrated that the
 * keying works: every range check ran against one ostomy type, so an
 * implementation that ignored `ostomy_type` entirely would have looked correct.
 *
 * These assertions are therefore comparative on purpose. A test that only
 * checked "colostomy output is under 400 mL/day" would pass against a generator
 * that had quietly become a second ileostomy with smaller numbers; comparing
 * the two datasets is what pins the clinical difference.
 */

import { ESTIMATION_METHOD_CODE, MEASURED_METHOD_CODE } from '@ostomy/core/validation';
import { describe, expect, it } from 'vitest';

import { generateScenario, type ScenarioName } from '../index.js';
import { STOMA_OUTPUT_LOINC_CODE, VOIDED_URINE_LOINC_CODE, type SeedDataset } from '../types.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const ESTIMATION_CODE = ESTIMATION_METHOD_CODE.resolved ? ESTIMATION_METHOD_CODE.code : null;
const MEASURED_CODE = MEASURED_METHOD_CODE.resolved ? MEASURED_METHOD_CODE.code : null;

function generate(name: ScenarioName) {
  return generateScenario(name, {
    oidcSubject: `ratio-${name}`,
    now: NOW,
    estimationMethodCode: ESTIMATION_CODE,
    measuredMethodCode: MEASURED_CODE,
  });
}

/** Mean measured stoma output per local day. */
function meanDailyOutput(dataset: SeedDataset): number {
  const totals = new Map<string, number>();
  for (const entry of dataset.observations) {
    if (entry.code !== STOMA_OUTPUT_LOINC_CODE || entry.valueQuantityValue === null) continue;
    totals.set(
      entry.localDate,
      (totals.get(entry.localDate) ?? 0) + Number(entry.valueQuantityValue),
    );
  }
  const values = [...totals.values()];
  return values.reduce((running, value) => running + value, 0) / values.length;
}

/** Mean measured volume of a single stoma-output entry. */
function meanEntryVolume(dataset: SeedDataset): number {
  const volumes = dataset.observations
    .filter((entry) => entry.code === STOMA_OUTPUT_LOINC_CODE && entry.valueQuantityValue !== null)
    .map((entry) => Number(entry.valueQuantityValue));

  return volumes.reduce((running, value) => running + value, 0) / volumes.length;
}

/** Mean stoma-output entries per local day. */
function meanEntriesPerDay(dataset: SeedDataset): number {
  const counts = new Map<string, number>();
  for (const entry of dataset.observations) {
    if (entry.code !== STOMA_OUTPUT_LOINC_CODE) continue;
    counts.set(entry.localDate, (counts.get(entry.localDate) ?? 0) + 1);
  }
  const values = [...counts.values()];
  return values.reduce((running, value) => running + value, 0) / values.length;
}

describe('colostomy-baseline', () => {
  const colostomy = generate('colostomy-baseline');
  const ileostomy = generate('stable-ileostomy');

  it('is a colostomy profile', () => {
    expect(colostomy.profile.ostomyType).toEqual('COLOSTOMY');
    // The other half of the v1 matrix, for contrast. Urostomy was deliberately
    // cut (SRS Appendix A) because a urostomy's stoma output IS urine — a
    // different data model, not a third enum value — so these two are the whole
    // matrix rather than a sample of it.
    expect(ileostomy.profile.ostomyType).toEqual('ILEOSTOMY');
  });

  it('produces materially less daily output than the ileostomy baseline', () => {
    // Water is absorbed further up, so output is lower and more formed. The
    // factor matters: an ileostomy range applied to a colostomy would never
    // flag anything, which is the direction that actually harms.
    expect(meanDailyOutput(colostomy)).toBeLessThan(meanDailyOutput(ileostomy) / 2);
  });

  it('empties fewer times a day than the ileostomy baseline', () => {
    expect(meanEntriesPerDay(colostomy)).toBeLessThan(meanEntriesPerDay(ileostomy));
  });

  /**
   * Per ENTRY, not just per day — and review proved this one was needed.
   *
   * Raising this scenario's per-entry range to the ileostomy baseline's exact
   * `120-320` — "the generator quietly became a second ileostomy" — left all six
   * tests green, because the daily `/2` ratio was carried almost entirely by the
   * entry COUNT. The docstring above claims the comparative form pins the
   * clinical difference; it pinned half of it.
   *
   * Volume per emptying is the half that encodes the physiology: water absorbed
   * further up the bowel means a smaller, more formed output each time, not
   * merely fewer trips.
   */
  it('produces a smaller volume per emptying, not just fewer of them', () => {
    expect(meanEntryVolume(colostomy)).toBeLessThan(meanEntryVolume(ileostomy) * 0.8);
  });

  it('lands in the range a colostomy default would be written against', () => {
    // Absolute as well as comparative, so a future change that halved BOTH
    // scenarios would still fail here rather than keeping the ratio and losing
    // the clinical plausibility.
    const mean = meanDailyOutput(colostomy);
    expect(mean).toBeGreaterThan(100);
    expect(mean).toBeLessThan(600);
  });

  it('seeds urine, so §3.7 has something to exclude', () => {
    // The exclusion of voided urine from Daily Net Fluid Balance is deliberate
    // and the web view shows the two figures adjacent and never combined. A
    // scenario with no urine cannot demonstrate that separation at all — there
    // would be nothing to exclude, and the rule would look untested.
    const urine = colostomy.observations.filter((entry) => entry.code === VOIDED_URINE_LOINC_CODE);

    expect(urine.length).toBeGreaterThan(0);
    for (const entry of urine) {
      expect(entry.urineColorCode).toBeTruthy();
    }
  });

  it('keeps the urine colours in the healthy part of the scale', () => {
    // This is the well-controlled contrast case. Dark urine here would muddle
    // it against `high-output-dehydration`, where darkening is the signal.
    for (const entry of colostomy.observations) {
      if (entry.code !== VOIDED_URINE_LOINC_CODE) continue;
      expect(['pale_straw', 'straw', 'yellow']).toContain(entry.urineColorCode);
    }
  });
});
