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
 * The seeded routines are what Quick-Add is supposed to find (#114).
 *
 * ## Why this test exists in this package
 *
 * The Quick-Add RULES are tested in `apps/mobile`, against fixtures built to
 * demonstrate them. What was never tested is whether any seeded DATA satisfies
 * them — and it did not: a freshly reset stack contained no repeated entry at
 * all, so the one widget a developer saw was an RNG collision at 0.1 mL
 * granularity, described on the dashboard as "you logged this 2 times recently"
 * and different after every reseed.
 *
 * So this asserts a property of the generated dataset, not of the rule.
 *
 * ## The duplication here is deliberate, and bounded
 *
 * `groupKey` below mirrors `apps/mobile/src/db/repositories/quickAddRepository.ts`'s
 * `GROUP BY`, and `packages/seed` cannot import from `apps/mobile`. A copy of a
 * rule is normally exactly what this repo refuses — so note what kind of copy
 * this is: if the real key gains a field, this test keeps passing while the
 * seeded routine may silently split into two groups and vanish from the
 * dashboard. That is a weaker guard than a shared implementation would be.
 *
 * It is still worth having, because the failure it does catch is the one that
 * actually happened: a generator change that makes a routine stop repeating.
 * **If you add a field to that GROUP BY, add it here too.**
 */

import { describe, expect, it } from 'vitest';

import { generateColostomyBaseline } from './colostomyBaseline.js';
import { generateStableIleostomy } from './stableIleostomy.js';
import {
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
  type SeedObservation,
} from '../types.js';

/** Mirrors `apps/mobile/src/quickadd/quickAddSuggestions.ts`. */
const RECENT_WINDOW_DAYS = 14;
const MINIMUM_OCCURRENCES = 2;
const MAX_SUGGESTIONS = 3;
const QUICK_ADD_CODES = [STOMA_OUTPUT_LOINC_CODE, FLUID_INTAKE_LOINC_CODE, VOIDED_URINE_LOINC_CODE];

const NOW = new Date('2026-10-08T12:00:00.000Z');
const OIDC_SUBJECT = 'seed-routine-spec';

/** The ADR-0018 codes, supplied the way `index.ts` supplies them. */
const CODES = {
  estimationMethodCode: '414135002',
  measuredMethodCode: '258104002',
};

interface Group {
  readonly key: string;
  readonly occurrences: number;
  readonly observation: SeedObservation;
}

function groupKey(observation: SeedObservation): string {
  return [
    observation.code,
    observation.valueQuantityValue ?? '',
    observation.method ?? '',
    observation.fluidTypeCode ?? '',
    observation.urineColorCode ?? '',
    observation.enteredMeasurementSystem,
  ].join('|');
}

/** What Quick-Add would offer, ranked as its own query ranks: occurrences first. */
function quickAddCandidates(observations: readonly SeedObservation[], now: Date = NOW): Group[] {
  const since = new Date(now.getTime() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const byKey = new Map<string, Group>();

  for (const observation of observations) {
    if (!QUICK_ADD_CODES.includes(observation.code)) continue;
    if (observation.effectiveDatetime < since) continue;

    const key = groupKey(observation);
    const existing = byKey.get(key);
    byKey.set(key, {
      key,
      occurrences: (existing?.occurrences ?? 0) + 1,
      observation: existing?.observation ?? observation,
    });
  }

  return [...byKey.values()]
    .filter((group) => group.occurrences >= MINIMUM_OCCURRENCES)
    .sort((a, b) => b.occurrences - a.occurrences);
}

describe('the seeded routines are what Quick-Add finds', () => {
  describe('colostomy-baseline — the scenario dev-reset seeds', () => {
    const dataset = generateColostomyBaseline({ now: NOW, oidcSubject: OIDC_SUBJECT, ...CODES });
    const candidates = quickAddCandidates(dataset.observations);
    const top = candidates.slice(0, MAX_SUGGESTIONS);

    /**
     * One widget per path. The three fail differently, and the two that a random
     * dataset never produced are the ones most worth looking at on a device.
     */
    it('offers one widget for each of the three entry paths', () => {
      expect(top.map((group) => group.observation.code).sort()).toEqual(
        [STOMA_OUTPUT_LOINC_CODE, FLUID_INTAKE_LOINC_CODE, VOIDED_URINE_LOINC_CODE].sort(),
      );
    });

    /**
     * The margin, not merely the floor.
     *
     * Clearing 2 by one entry would make the widgets depend on an RNG draw again,
     * which is the defect this fixes rather than a weaker version of it. The
     * skip rate leaves roughly 12 of 14 days, so anything near the floor means
     * the routine has stopped repeating.
     */
    it('repeats each routine most days, not barely twice', () => {
      for (const group of top) {
        expect(group.occurrences).toBeGreaterThanOrEqual(8);
      }
    });

    it('ranks every routine above every incidental collision', () => {
      const lowest = Math.min(...top.map((group) => group.occurrences));
      const others = candidates.slice(MAX_SUGGESTIONS);
      for (const group of others) {
        expect(group.occurrences).toBeLessThan(lowest);
      }
    });

    /**
     * The ranking has to hold for every fourteen-day window, not for the one this
     * file picks.
     *
     * Checked against a real database rather than imagined: at the first skip
     * rate the fourth routine landed 9 against the output routine's 10 — one
     * entry apart, so a different "now" would have flipped them and the dashboard
     * would have shown two intake widgets and no output one. A single fixed
     * instant cannot see that, which is exactly the kind of green this repo
     * treats as meaning less than it appears.
     */
    it.each([0, 1, 2, 3, 5, 8, 13, 21, 34])(
      'still offers one widget per path %i days later',
      (daysLater) => {
        const now = new Date(NOW.getTime() + daysLater * 24 * 60 * 60 * 1000);
        const shifted = generateColostomyBaseline({ now, oidcSubject: OIDC_SUBJECT, ...CODES });
        const ranked = quickAddCandidates(shifted.observations, now).slice(0, MAX_SUGGESTIONS);

        expect(ranked.map((group) => group.observation.code).sort()).toEqual(
          [STOMA_OUTPUT_LOINC_CODE, FLUID_INTAKE_LOINC_CODE, VOIDED_URINE_LOINC_CODE].sort(),
        );
      },
    );

    /**
     * The volumeless path (SRS §3.7, AC 12.1 AC2). A widget built from this entry
     * has to render the colour and no amount — `0 mL` would be a reading nobody
     * took — so the dataset has to contain one for that to be visible at all.
     */
    it('includes a colour-only urine routine, with no volume', () => {
      const urine = top.find((group) => group.observation.code === VOIDED_URINE_LOINC_CODE);
      expect(urine?.observation.valueQuantityValue).toBeNull();
      expect(urine?.observation.urineColorCode).toBe('straw');
      // ADR-0018: an entry with no volume has nothing to qualify.
      expect(urine?.observation.method).toBeNull();
    });

    it('includes a categorised intake routine, so the widget can name the fluid', () => {
      const intake = top.find((group) => group.observation.code === FLUID_INTAKE_LOINC_CODE);
      expect(intake?.observation.fluidTypeCode).toBe('coffee_or_tea');
    });

    /**
     * The property the fourth routine exists to demonstrate: a 250 mL coffee and
     * a 250 mL water are DIFFERENT entries, because fluid type is part of the
     * grouping key. Identical in volume, hour and method; two groups.
     *
     * It is seeded rarer than the three above so it ranks fourth — the dashboard
     * shows one widget per path, and the distinction lives in the data for anyone
     * who queries it.
     */
    it('seeds the same volume as two fluids, which group separately', () => {
      const sameVolume = candidates.filter(
        (group) =>
          group.observation.code === FLUID_INTAKE_LOINC_CODE &&
          group.observation.valueQuantityValue === '250.0',
      );

      expect(sameVolume.map((group) => group.observation.fluidTypeCode).sort()).toEqual([
        'coffee_or_tea',
        'water',
      ]);
      expect(sameVolume.every((group) => group.occurrences >= MINIMUM_OCCURRENCES)).toBe(true);
    });
  });

  describe('stable-ileostomy — the ileostomy baseline', () => {
    const dataset = generateStableIleostomy({ now: NOW, oidcSubject: OIDC_SUBJECT, ...CODES });
    const candidates = quickAddCandidates(dataset.observations);

    it('offers a repeated stoma-output routine', () => {
      const top = candidates[0];
      expect(top?.observation.code).toBe(STOMA_OUTPUT_LOINC_CODE);
      expect(top?.observation.valueQuantityValue).toBe('240.0');
      expect(top?.occurrences).toBeGreaterThanOrEqual(8);
    });

    /**
     * This scenario emits only stoma output, so it can seed only the volumetric
     * path. Asserted rather than left implicit, because the limitation is the
     * reason `dev-reset.sh` defaults to `colostomy-baseline` — if this scenario
     * ever gains intake or urine, that default deserves revisiting.
     */
    it('exercises only the volumetric path, which is why it is not the default', () => {
      const codes = new Set(candidates.map((group) => group.observation.code));
      expect([...codes]).toEqual([STOMA_OUTPUT_LOINC_CODE]);
    });
  });

  /**
   * Determinism is the half of ADR-0009 this issue actually broke: the widgets a
   * developer saw changed on every reseed, because they came from a collision
   * rather than from anything the generator intended.
   */
  it('produces the same widgets for the same seed and the same now', () => {
    const first = quickAddCandidates(
      generateColostomyBaseline({ now: NOW, oidcSubject: OIDC_SUBJECT, ...CODES }).observations,
    );
    const second = quickAddCandidates(
      generateColostomyBaseline({ now: NOW, oidcSubject: OIDC_SUBJECT, ...CODES }).observations,
    );

    expect(
      first.slice(0, MAX_SUGGESTIONS).map((group) => `${group.key}x${group.occurrences}`),
    ).toEqual(second.slice(0, MAX_SUGGESTIONS).map((group) => `${group.key}x${group.occurrences}`));
  });
});
