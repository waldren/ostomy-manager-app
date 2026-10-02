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
 * The properties EVERY scenario must have, driven from `SCENARIO_NAMES`.
 *
 * Table-driven on purpose rather than repeated per scenario. P3.S5 took the
 * package from one scenario to five, and the alternative was five copies of the
 * same assertions — which is how this repo got three different `ZodError`
 * mappings (#100) and how HW-11 came to be missing from its own list. Deriving
 * the list from the registry means **a scenario added later is covered the day
 * it is added**, without anyone remembering to extend a spec.
 *
 * Per-scenario specs cover what each scenario specifically claims. This file
 * covers what none of them is allowed to get wrong.
 */

import { ESTIMATION_METHOD_CODE, MEASURED_METHOD_CODE } from '@ostomy/core/validation';
import type { VolumetricValidationThresholds } from '@ostomy/core/validation';
import { toLocalDate } from '@ostomy/core/units';
import { describe, expect, it } from 'vitest';

import {
  SCENARIO_NAMES,
  findTier1Problems,
  findTier2Warnings,
  generateScenario,
  type ScenarioName,
} from '../index.js';
import { STOMA_OUTPUT_LOINC_CODE, VOIDED_URINE_LOINC_CODE } from '../types.js';

const NOW = new Date('2026-10-02T12:00:00.000Z');

/** The seeding migration's defaults — see `stableIleostomy.spec.ts` on why these are written out. */
const THRESHOLDS: VolumetricValidationThresholds = {
  softWarningMaxMl: 2000,
  maxClockSkewMs: 300_000,
};

const ESTIMATION_CODE = ESTIMATION_METHOD_CODE.resolved ? ESTIMATION_METHOD_CODE.code : null;
const MEASURED_CODE = MEASURED_METHOD_CODE.resolved ? MEASURED_METHOD_CODE.code : null;

function generate(name: ScenarioName, overrides: { seed?: number; now?: Date } = {}) {
  return generateScenario(name, {
    oidcSubject: `invariants-${name}`,
    now: overrides.now ?? NOW,
    estimationMethodCode: ESTIMATION_CODE,
    measuredMethodCode: MEASURED_CODE,
    ...(overrides.seed === undefined ? {} : { seed: overrides.seed }),
  });
}

/** Every scenario trips Tier 2 by design in exactly one case. */
const TIER_2_IS_THE_POINT: ScenarioName = 'validation-edge-cases';

describe.each([...SCENARIO_NAMES])('%s', (name) => {
  it('passes the application own Tier 1 rules, with no row rejected', () => {
    // ADR-0009: validated against `packages/core`, not against a local copy of
    // the rules, so a rule change automatically constrains the seed data.
    expect(findTier1Problems(generate(name), THRESHOLDS, NOW)).toEqual([]);
  });

  it('trips a Tier 2 warning only where that is the stated purpose', () => {
    const warnings = findTier2Warnings(generate(name), THRESHOLDS, NOW);

    if (name === TIER_2_IS_THE_POINT) {
      // `deployment-development.md` exempts this one scenario from "valid by
      // construction" because producing warnings is what it is for.
      expect(warnings.length).toBeGreaterThan(0);
    } else {
      // Everywhere else a warning is a generator bug: a demo dataset that warns
      // on ordinary rows teaches the person reading it to dismiss warnings,
      // which is the failure SRS §3.8 cares most about.
      expect(warnings).toEqual([]);
    }
  });

  it('is deterministic for the same seed and the same now', () => {
    // The property the package exists for (ADR-0009): a bug found against
    // seeded data reproduces by name and seed, because a database dump from a
    // dev host is the artifact that must never circulate.
    expect(JSON.stringify(generate(name))).toEqual(JSON.stringify(generate(name)));
  });

  it('produces different data for a different seed', () => {
    // Otherwise the seed is decorative and every "deterministic" assertion
    // above is vacuous.
    expect(JSON.stringify(generate(name))).not.toEqual(
      JSON.stringify(generate(name, { seed: 0x5eed1 })),
    );
  });

  it('generates at least one observation', () => {
    expect(generate(name).observations.length).toBeGreaterThan(0);
  });

  it('places every entry strictly in the past', () => {
    // Tier 1's EFFECTIVE_DATE_TIME_IN_FUTURE. Asserted here as well as guarded
    // in each generator, because the guard is what a future edit removes.
    for (const observation of generate(name).observations) {
      expect(observation.effectiveDatetime.getTime()).toBeLessThan(NOW.getTime());
    }
  });

  it('places every entry on or after the surgery date', () => {
    const dataset = generate(name);
    for (const observation of dataset.observations) {
      expect(observation.effectiveDatetime.getTime()).toBeGreaterThanOrEqual(
        dataset.profile.surgeryDate.getTime(),
      );
    }
  });

  it('derives localDate from the shared helper, for the entry own zone', () => {
    // ADR-0016. Computed any other way, a row stored day disagrees with its own
    // instant — and every assertion about a day would then be wrong together,
    // which is why this compares against the helper rather than against a
    // hand-rolled expectation.
    for (const observation of generate(name).observations) {
      expect(observation.localDate).toEqual(
        toLocalDate(observation.effectiveDatetime, observation.enteredTimezone),
      );
    }
  });

  it('holds every volume inside what the canonical column can store', () => {
    for (const observation of generate(name).observations) {
      if (observation.valueQuantityValue === null) continue;
      const value = observation.valueQuantityValue;
      // DECIMAL(12,4): more than four fractional digits is
      // VALUE_EXCEEDS_MAX_PRECISION, and 10^8 or beyond overflows the column.
      expect(value.split('.')[1]?.length ?? 0).toBeLessThanOrEqual(4);
      expect(Number(value)).toBeGreaterThan(0);
      expect(Math.abs(Number(value))).toBeLessThan(100_000_000);
    }
  });

  /**
   * The four CHECK constraints P3.S2 put on `observations`, asserted here so a
   * generator that violates one fails in this suite rather than at the writer
   * with a Postgres constraint name.
   */
  describe('the volume and colour constraints', () => {
    it('keeps a volume and its unit together', () => {
      for (const observation of generate(name).observations) {
        expect(observation.valueQuantityValue === null).toEqual(
          observation.valueQuantityUnit === null,
        );
      }
    });

    it('omits a volume only on voided urine, and only with a colour', () => {
      for (const observation of generate(name).observations) {
        if (observation.valueQuantityValue !== null) continue;
        expect(observation.code).toEqual(VOIDED_URINE_LOINC_CODE);
        expect(observation.urineColorCode).toBeTruthy();
      }
    });

    it('never attaches a colour to anything but voided urine', () => {
      for (const observation of generate(name).observations) {
        if (observation.urineColorCode == null) continue;
        expect(observation.code).toEqual(VOIDED_URINE_LOINC_CODE);
      }
    });

    it('never qualifies an entry that has no volume', () => {
      // `method` requires a volume: a Measured/Estimated answer about nothing is
      // meaningless, and `validateVolumelessObservation` reports
      // METHOD_NOT_APPLICABLE for it.
      for (const observation of generate(name).observations) {
        if (observation.valueQuantityValue !== null) continue;
        expect(observation.method).toBeNull();
      }
    });
  });

  it('never seeds a zero volume, because a missing volume is not zero', () => {
    // The distinction CLAUDE.md is most emphatic about. `SUM()` skips NULL and
    // code that coerces it does not, so a scenario that wrote 0 for "unmeasured"
    // would bake the disagreement into the demo data.
    for (const observation of generate(name).observations) {
      expect(observation.valueQuantityValue).not.toEqual('0');
      expect(observation.valueQuantityValue).not.toEqual('0.0');
    }
  });

  it('emits stoma output, which is what makes it an ostomy dataset', () => {
    const codes = new Set(generate(name).observations.map((entry) => entry.code));
    expect(codes).toContain(STOMA_OUTPUT_LOINC_CODE);
  });

  it('keeps every row on its own patient', () => {
    const dataset = generate(name);
    for (const observation of dataset.observations) {
      expect(observation.patientId).toEqual(dataset.patient.id);
    }
    expect(dataset.profile.patientId).toEqual(dataset.patient.id);
  });

  it('reports the name it was asked for', () => {
    // The dataset's own label is what the writer and the reset script log, so a
    // copy-paste between generators is worth catching here.
    expect(generate(name).scenario).toEqual(name);
  });
});

/**
 * Across scenarios rather than within one.
 *
 * `deterministicUuid` is driven by the scenario's seed, so two scenarios
 * sharing a default seed would mint the same patient id — and the second one
 * written to a database would collide on the primary key, at `dev-reset` time,
 * with a Postgres error rather than a useful message.
 */
describe('across every scenario', () => {
  it('mints a distinct patient id per scenario', () => {
    const ids = SCENARIO_NAMES.map((name) => generate(name).patient.id);

    expect(new Set(ids).size).toEqual(ids.length);
  });

  it('mints a distinct observation id for every row everywhere', () => {
    const ids = SCENARIO_NAMES.flatMap((name) =>
      generate(name).observations.map((observation) => observation.id),
    );

    expect(new Set(ids).size).toEqual(ids.length);
  });
});
