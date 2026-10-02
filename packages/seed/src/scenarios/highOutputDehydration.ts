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
 * A patient sliding into dehydration over six weeks.
 *
 * `deployment-development.md`: "Output climbing past the excessive threshold
 * while intake stays flat and urine output falls; exercises anomaly flags and
 * the §3.7 hydration indicator together."
 *
 * The three curves are the whole point, and they only mean something together.
 * Output rising alone is a high-output stoma; output rising *while intake stays
 * flat and urine falls* is a patient losing fluid faster than they are
 * replacing it, which is what §3.7's indicator exists to surface and what the
 * physician view (§3.5) has to make legible across three separate signals.
 *
 * This scenario could not be written before P3.S5. The seeder could express a
 * stoma-output row and nothing else, so two of its three curves were
 * unrepresentable — see `types.ts`.
 *
 * ## Two things it deliberately does and one it deliberately does not
 *
 * **Urine darkens as it falls.** `urine_color` runs `pale_straw` to `brown`,
 * and concentration tracking volume is the clinically real correlation — a
 * scenario where a falling volume kept a pale colour would teach the opposite
 * of the thing being demonstrated. The codes are the live value set's, read
 * from the running stack rather than guessed.
 *
 * **The last days include colour-only urine entries.** A patient this unwell
 * stops measuring, and SRS §3.7 / AC 12.1 AC2 make that a valid entry rather
 * than a missing one. It is also the only way to exercise the volumeless path
 * with seeded data — and it is precisely where "a missing volume is never zero"
 * bites: a reader summing urine output across these days gets a *lower* total
 * than the patient produced, and the §3.7 block has to say how much of the day
 * it actually covers rather than rendering a reassuring number.
 *
 * **No weight signal.** Weight is the third hydration signal and would fit the
 * story, but `findTier1Problems` validates every row through the volumetric
 * entry point, which is mL-shaped — a kg value would be checked against a
 * millilitre bound. Routing weight correctly is its own change, so this
 * scenario stays within the two signals the validator actually models rather
 * than seeding rows whose validation means nothing.
 */

import { URINE_COLOR_CODES_PALE_TO_DARK } from '@ostomy/core/hydration';

import {
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
  type ScenarioOptions,
  type SeedDataset,
  type SeedObservation,
} from '../types.js';
import { createRng, deterministicUuid, type Rng } from '../rng.js';
import {
  addDays,
  assertInPast,
  entryInstant,
  observationAt,
  startOfUtcDay,
  type GeneratorCodes,
} from './shared.js';

const SCENARIO = 'high-output-dehydration';
// Arbitrary, but distinct from every other scenario's, which is the only real
// requirement: the seed drives `deterministicUuid`, so two scenarios sharing
// one would mint the same patient id and the second write would collide.
const DEFAULT_SEED = 0xdeca11;
const DEFAULT_TIME_ZONE = 'America/Chicago';

const HISTORY_DAYS = 45;
const SURGERY_DAYS_AGO = 200;

/** The day the slide begins. Before this, the patient is a stable baseline. */
const DECLINE_STARTS_AT_DAY_OFFSET = 30;

/** Daily output totals, baseline to worst. The ceiling clears the >2,000 mL/day excessive bound. */
const OUTPUT_ML_PER_DAY_BASELINE = 1000;
const OUTPUT_ML_PER_DAY_WORST = 2600;

/**
 * Intake is flat on purpose: a patient not realising they must drink more.
 *
 * Jittered within a few percent rather than held to the millilitre. Review
 * pointed out that a 45-day line flat to within 2 mL is not a curve a human
 * produces, and the comparison this scenario makes — output rising while intake
 * does not — survives the jitter intact. The spec asserts "no upward trend"
 * rather than "identical", which is the honest version of the claim.
 */
const INTAKE_ML_PER_DAY = 1800;
const INTAKE_JITTER = 0.06;

/** Urine falls as the kidneys conserve. 450 mL/day is frankly oliguric. */
const URINE_ML_PER_DAY_BASELINE = 1300;
const URINE_ML_PER_DAY_WORST = 450;

/**
 * Light to dark — imported, not retyped.
 *
 * `packages/core`'s `hydration` module already publishes this ordering and uses
 * it to score concentration, so a local copy is a second home for a clinical
 * list. Review caught it as byte-identical duplication, which is the shape
 * CLAUDE.md names: a list that must have one home.
 */
const URINE_COLORS = URINE_COLOR_CODES_PALE_TO_DARK;

/** Water early; oral rehydration solution appears as the patient tries to compensate. */
const EARLY_FLUIDS = ['water', 'coffee_or_tea', 'juice'] as const;
const LATE_FLUIDS = ['water', 'oral_rehydration_solution', 'soup_or_broth'] as const;

/** The last stretch, where some urine entries carry a colour and no volume. */
const UNMEASURED_URINE_FROM_DAY_OFFSET = 5;
const UNMEASURED_IN_N = 2;

const ESTIMATED_IN_N = 5;

export function generateHighOutputDehydration(
  options: ScenarioOptions & GeneratorCodes,
): SeedDataset {
  const rng = createRng(options.seed ?? DEFAULT_SEED);
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const patientId = deterministicUuid(rng);
  const profileId = deterministicUuid(rng);
  const surgeryDate = startOfUtcDay(addDays(options.now, -SURGERY_DAYS_AGO));

  const observations: SeedObservation[] = [];

  // Oldest first, so ids and timestamps advance together.
  for (let dayOffset = HISTORY_DAYS; dayOffset >= 1; dayOffset -= 1) {
    const severity = severityAt(dayOffset);

    observations.push(
      ...outputForDay({ rng, patientId, timeZone, options, dayOffset, severity }),
      ...intakeForDay({ rng, patientId, timeZone, options, dayOffset, severity }),
      ...urineForDay({ rng, patientId, timeZone, options, dayOffset, severity }),
    );
  }

  return {
    scenario: SCENARIO,
    patient: { id: patientId, oidcSubject: options.oidcSubject },
    profile: {
      id: profileId,
      patientId,
      ostomyType: 'ILEOSTOMY',
      surgeryDate,
      measurementSystem: 'metric',
      clientUpdatedAt: options.now,
    },
    observations,
  };
}

/**
 * 0 at the start of history, 1 on the most recent day.
 *
 * Linear rather than a curve: the point is that a reader can see the trend and
 * say where it crossed a threshold, not that it models a physiological model
 * nobody here has validated.
 */
function severityAt(dayOffset: number): number {
  if (dayOffset > DECLINE_STARTS_AT_DAY_OFFSET) return 0;
  return (DECLINE_STARTS_AT_DAY_OFFSET - dayOffset) / (DECLINE_STARTS_AT_DAY_OFFSET - 1);
}

function lerp(from: number, to: number, fraction: number): number {
  return from + (to - from) * fraction;
}

interface DayInput {
  readonly rng: Rng;
  readonly patientId: string;
  readonly timeZone: string;
  readonly options: ScenarioOptions & GeneratorCodes;
  readonly dayOffset: number;
  readonly severity: number;
}

/**
 * A day's total split into entries, each jittered.
 *
 * Split rather than generated per entry, so the DAILY total is the thing under
 * control — which is what §3.9's ranges and §3.5's physician view read. Per
 * entry randomness with no daily budget produces a chart whose trend is noise.
 */
function splitDailyTotal(rng: Rng, total: number, entries: number): number[] {
  const weights = Array.from({ length: entries }, () => rng.floatBetween(0.7, 1.3, 3));
  const sum = weights.reduce((running, weight) => running + weight, 0);
  return weights.map((weight) => (total * weight) / sum);
}

function outputForDay(input: DayInput): SeedObservation[] {
  const { rng } = input;
  const total = lerp(OUTPUT_ML_PER_DAY_BASELINE, OUTPUT_ML_PER_DAY_WORST, input.severity);
  // More frequent emptying as output rises, which is what actually happens.
  const entries = input.severity < 0.5 ? rng.intBetween(4, 5) : rng.intBetween(6, 8);

  return splitDailyTotal(rng, total, entries).map((volume) => {
    const instant = entryInstant(rng, input.options.now, input.dayOffset, input.timeZone);
    assertInPast(SCENARIO, instant, input.options.now, input.dayOffset);
    const estimated =
      input.options.estimationMethodCode !== null && rng.intBetween(1, ESTIMATED_IN_N) === 1;

    return observationAt({
      rng,
      patientId: input.patientId,
      code: STOMA_OUTPUT_LOINC_CODE,
      effectiveDatetime: instant,
      timeZone: input.timeZone,
      valueQuantityValue: volume.toFixed(1),
      codes: input.options,
      estimated,
    });
  });
}

function intakeForDay(input: DayInput): SeedObservation[] {
  const { rng } = input;
  const entries = rng.intBetween(5, 7);
  const fluids = input.severity < 0.5 ? EARLY_FLUIDS : LATE_FLUIDS;

  const dailyTotal = INTAKE_ML_PER_DAY * rng.floatBetween(1 - INTAKE_JITTER, 1 + INTAKE_JITTER, 3);

  return splitDailyTotal(rng, dailyTotal, entries).map((volume) => {
    const instant = entryInstant(rng, input.options.now, input.dayOffset, input.timeZone);
    assertInPast(SCENARIO, instant, input.options.now, input.dayOffset);

    return observationAt({
      rng,
      patientId: input.patientId,
      code: FLUID_INTAKE_LOINC_CODE,
      effectiveDatetime: instant,
      timeZone: input.timeZone,
      codes: input.options,
      valueQuantityValue: volume.toFixed(1),
      // Always categorised. P3.S2 found `fluidTypeCode` missing from the sync
      // path, so every intake entry logged offline lost its categorisation —
      // seeding it uncategorised would reproduce that hole in the demo data.
      fluidTypeCode: fluids[rng.intBetween(0, fluids.length - 1)] ?? 'water',
    });
  });
}

function urineForDay(input: DayInput): SeedObservation[] {
  const { rng } = input;
  const total = lerp(URINE_ML_PER_DAY_BASELINE, URINE_ML_PER_DAY_WORST, input.severity);
  const entries = rng.intBetween(3, 5);

  // Darkens with severity, with a little jitter so it is not a clean ramp.
  const colorIndex = Math.min(
    URINE_COLORS.length - 1,
    Math.max(0, Math.round(input.severity * (URINE_COLORS.length - 1)) + rng.intBetween(-1, 0)),
  );
  const color = URINE_COLORS[colorIndex] ?? 'yellow';

  return splitDailyTotal(rng, total, entries).map((volume) => {
    const instant = entryInstant(rng, input.options.now, input.dayOffset, input.timeZone);
    assertInPast(SCENARIO, instant, input.options.now, input.dayOffset);

    const unmeasured =
      input.dayOffset <= UNMEASURED_URINE_FROM_DAY_OFFSET &&
      rng.intBetween(1, UNMEASURED_IN_N) === 1;

    return observationAt({
      rng,
      patientId: input.patientId,
      code: VOIDED_URINE_LOINC_CODE,
      effectiveDatetime: instant,
      timeZone: input.timeZone,
      codes: input.options,
      // Omitted, never zero: `SUM()` skips NULL and code that coerces does not.
      ...(unmeasured ? {} : { valueQuantityValue: volume.toFixed(1) }),
      urineColorCode: color,
    });
  });
}
