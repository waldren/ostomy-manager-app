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
 * The sparseness, the narrow window, and the imperial profile.
 *
 * `invariants.spec.ts` covers validity and determinism. What this scenario
 * uniquely claims is that it is *thin* — days with nothing logged, days with
 * output and no intake — because that is the shape of a real first fortnight
 * and the shape every other scenario lacks.
 */

import { ESTIMATION_METHOD_CODE, MEASURED_METHOD_CODE } from '@ostomy/core/validation';
import { describe, expect, it } from 'vitest';

import { generateScenario } from '../index.js';
import { FLUID_INTAKE_LOINC_CODE, STOMA_OUTPUT_LOINC_CODE } from '../types.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const ESTIMATION_CODE = ESTIMATION_METHOD_CODE.resolved ? ESTIMATION_METHOD_CODE.code : null;
const MEASURED_CODE = MEASURED_METHOD_CODE.resolved ? MEASURED_METHOD_CODE.code : null;

function generate(seed?: number) {
  return generateScenario('new-post-op', {
    oidcSubject: 'post-op',
    now: NOW,
    estimationMethodCode: ESTIMATION_CODE,
    measuredMethodCode: MEASURED_CODE,
    ...(seed === undefined ? {} : { seed }),
  });
}

describe('new-post-op', () => {
  const dataset = generate();
  const days = new Set(dataset.observations.map((entry) => entry.localDate));

  it('sets the surgery date to the start of the day two weeks back', () => {
    /**
     * Compared as a date, not as a rounded day count — and the first version of
     * this test got that wrong rather than the generator.
     *
     * The surgery date is the START of the UTC day fourteen days back, so from a
     * midday `now` the elapsed time is fourteen and a half days, which rounds to
     * fifteen. The generator is right: a surgery date is a date, and flooring it
     * is what makes it usable as the Tier 1 lower bound for entries at any hour
     * of that day.
     */
    expect(dataset.profile.surgeryDate.toISOString()).toEqual('2026-09-18T00:00:00.000Z');
    expect(dataset.profile.surgeryDate.getTime()).toBeLessThan(NOW.getTime());
  });

  it('is the early post-op window §3.9 keys its defaults to', () => {
    // Fourteen days of history is not enough to adapt a range from, so this
    // patient can only have clinical defaults — which is the path being
    // exercised. Asserted on the window itself rather than on `days.size <= 14`,
    // which was dead: `HISTORY_DAYS` is 13, so the next test's `< 13` already
    // implied it.
    const spanDays = (NOW.getTime() - dataset.profile.surgeryDate.getTime()) / 86_400_000;

    expect(spanDays).toBeLessThan(15);
    expect(days.size).toBeGreaterThan(0);
  });

  it('leaves days with nothing logged at all', () => {
    // The feature, not a gap. A tidy daily history hides the "no entries today"
    // case entirely, and a day with no output is absent rather than zero — the
    // same distinction CLAUDE.md draws for a missing volume, one level up.
    expect(days.size).toBeLessThan(13);
  });

  it('stays sparse within a day as well as across days', () => {
    const perDay = new Map<string, number>();
    for (const entry of dataset.observations) {
      if (entry.code !== STOMA_OUTPUT_LOINC_CODE) continue;
      perDay.set(entry.localDate, (perDay.get(entry.localDate) ?? 0) + 1);
    }

    for (const count of perDay.values()) {
      expect(count).toBeLessThanOrEqual(3);
    }
  });

  it('produces days with output and no intake', () => {
    // The §3.7 case the web view must call an incomplete balance rather than
    // rendering a large negative number that reads as a severe deficit.
    const intakeDays = new Set(
      dataset.observations
        .filter((entry) => entry.code === FLUID_INTAKE_LOINC_CODE)
        .map((entry) => entry.localDate),
    );
    const outputDays = [...days].filter((day) => !intakeDays.has(day));

    expect(outputDays.length).toBeGreaterThan(0);
  });

  it('is the one imperial scenario, so ADR-0004 conversion has real history', () => {
    // Stored values stay canonical mL regardless; nothing rewrites them when
    // the preference changes. Every other scenario is metric, which would have
    // left the render-time conversion path unexercised by seeded data.
    expect(dataset.profile.measurementSystem).toEqual('imperial');
    for (const entry of dataset.observations) {
      expect(entry.enteredMeasurementSystem).toEqual('imperial');
      expect(entry.valueQuantityUnit).toEqual('mL');
    }
  });

  it('refuses to generate an entry before the surgery date', () => {
    // The guard the other scenarios do not need: with a fourteen-day window an
    // entry can actually approach the boundary, and ENTRY_BEFORE_SURGERY_DATE is
    // a Tier 1 block. Checked across many seeds because it is a boundary the
    // RNG walks up to rather than one a single run proves.
    for (let seed = 1; seed <= 40; seed += 1) {
      const candidate = generate(seed);
      for (const entry of candidate.observations) {
        expect(entry.effectiveDatetime.getTime()).toBeGreaterThanOrEqual(
          candidate.profile.surgeryDate.getTime(),
        );
      }
    }
  });
});
