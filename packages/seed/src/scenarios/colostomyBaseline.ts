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
 * A settled colostomy.
 *
 * `deployment-development.md`: "A colostomy profile, so ostomy-type-dependent
 * ranges are visibly different."
 *
 * ## Why the numbers are so much lower, and why that matters here
 *
 * A colostomy sits further down the bowel, so water has already been absorbed:
 * output is lower in volume, more formed, and emptied a couple of times a day
 * rather than six. An ileostomy's 1,000 mL over five or six emptyings becomes
 * roughly 300 mL over two.
 *
 * That ratio is the entire purpose of this scenario. `clinical_default_ranges`
 * is keyed on `ostomy_type` (CLAUDE.md, and the admin surface P3.S3 shipped),
 * and a range that is correct for an ileostomy is wrong for a colostomy by
 * about a factor of three — in the direction that matters, since an ileostomy
 * range applied to a colostomy would never flag anything. With only
 * `stable-ileostomy` seeded, **nothing in this repository demonstrated that the
 * keying works**: every range check ran against the one ostomy type, so a
 * version that ignored `ostomy_type` entirely would have looked correct.
 *
 * v1 covers colostomy and ileostomy only, and urostomy was deliberately cut
 * (SRS Appendix A) because a urostomy's stoma output *is* urine — a different
 * data model, not a third enum value. So these two scenarios are the whole
 * matrix, not a sample of it.
 */

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
  routineHappensToday,
  routineInstant,
  startOfUtcDay,
  type GeneratorCodes,
} from './shared.js';

const SCENARIO = 'colostomy-baseline';
// Arbitrary but distinct — see `highOutputDehydration.ts` on why that matters.
const DEFAULT_SEED = 0xc0105a;
const DEFAULT_TIME_ZONE = 'America/Chicago';

const HISTORY_DAYS = 90;
const SURGERY_DAYS_AGO = 320;

/** One to three emptyings a day, against an ileostomy's four to six. */
const ENTRIES_PER_DAY_MIN = 1;
const ENTRIES_PER_DAY_MAX = 3;

/** Lower per entry too, so the daily total lands around 300 mL rather than 1,000. */
const ENTRY_ML_MIN = 80;
const ENTRY_ML_MAX = 220;

const INTAKE_ENTRIES_MIN = 4;
const INTAKE_ENTRIES_MAX = 6;
const INTAKE_ML_MIN = 200;
const INTAKE_ML_MAX = 400;
const FLUIDS = ['water', 'coffee_or_tea', 'juice', 'milk'] as const;

/**
 * Urine is normal here, and it is seeded for a reason that is easy to miss:
 * §3.7 excludes voided urine from Daily Net Fluid Balance on purpose, and the
 * web view shows the two figures adjacent and never combined. A scenario with
 * output and intake but no urine cannot demonstrate that separation at all —
 * the exclusion would be untested because there would be nothing to exclude.
 */
const URINE_ENTRIES_MIN = 4;
const URINE_ENTRIES_MAX = 6;
const URINE_ML_MIN = 200;
const URINE_ML_MAX = 400;
const HEALTHY_URINE_COLORS = ['pale_straw', 'straw', 'yellow'] as const;

const ESTIMATED_IN_N = 8;

/**
 * This patient's habits (#114).
 *
 * Three of them, one per Quick-Add path, because the three paths fail
 * differently and the one most worth eyeballing is the one a random dataset
 * never produces:
 *
 * - **A morning emptying.** The volumetric path.
 * - **A morning coffee.** The fluid-type path: the widget has to say *coffee*,
 *   because a 250 mL coffee and a 250 mL water are different entries and a tap
 *   that logged the wrong one would be logging something the patient did not do.
 * - **A first-of-the-day urine with a colour and no volume** (SRS §3.7, AC 12.1
 *   AC2). The volumeless path — the one entry this system stores with no
 *   `valueQuantity`, and the one whose widget must not render as `0 mL`.
 *
 * Quick-Add shows at most three, ordered by occurrence count, so these three
 * fill the dashboard and the incidental RNG collisions that used to fill it
 * cannot reach it.
 *
 * The fourth is deliberately rarer than the other three: the SAME 250 mL at the
 * same hour, as water rather than coffee. It clears the floor of two, so the
 * data proves fluid type is part of the grouping key, while ranking below the
 * three above so the dashboard still demonstrates one path each. A test asserts
 * both halves of that.
 */
const ROUTINE_SKIP_ONE_IN_N = 7;

const MORNING_EMPTYING_HOUR = 7;
const MORNING_EMPTYING_ML = '150.0';

const MORNING_DRINK_HOUR = 8;
const MORNING_DRINK_ML = '250.0';
const MORNING_DRINK_FLUID = 'coffee_or_tea';

/**
 * Rarer, so it ranks fourth: same volume and hour, different fluid. See above.
 *
 * Every OTHER day rather than two in three, and the margin is the point. At
 * one-in-three it landed 9 occurrences against the stoma-output routine's 10 in
 * a real fourteen-day window — one entry apart, so a different "now" could flip
 * them and the dashboard would show two intake widgets and no output one. The
 * ranking has to hold for every window, not for the one a test happens to pick.
 */
const WATER_CHASER_SKIP_ONE_IN_N = 2;
const WATER_CHASER_FLUID = 'water';

const FIRST_URINE_HOUR = 7;
const FIRST_URINE_COLOR = 'straw';

export function generateColostomyBaseline(options: ScenarioOptions & GeneratorCodes): SeedDataset {
  const rng = createRng(options.seed ?? DEFAULT_SEED);
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const patientId = deterministicUuid(rng);
  const profileId = deterministicUuid(rng);
  const surgeryDate = startOfUtcDay(addDays(options.now, -SURGERY_DAYS_AGO));

  const observations: SeedObservation[] = [];

  for (let dayOffset = HISTORY_DAYS; dayOffset >= 1; dayOffset -= 1) {
    const context = { rng, patientId, timeZone, options, dayOffset };

    /**
     * Drawn once each, not in the loop condition.
     *
     * The first version put `rng.intBetween(...)` in the condition, so the bound
     * was re-rolled every iteration. It stayed deterministic and the counts
     * stayed inside their ranges, but the distribution was not the uniform draw
     * the constants read as — "one to three emptyings a day" came out at a mean
     * of 1.72 rather than 2 — and the day someone sets a MIN of 0 it becomes a
     * geometric process. `newPostOp.ts` already did this correctly.
     */
    const outputEntries = rng.intBetween(ENTRIES_PER_DAY_MIN, ENTRIES_PER_DAY_MAX);
    const intakeEntries = rng.intBetween(INTAKE_ENTRIES_MIN, INTAKE_ENTRIES_MAX);
    const urineEntries = rng.intBetween(URINE_ENTRIES_MIN, URINE_ENTRIES_MAX);

    /**
     * The habits first, so they sit at the start of the day they belong to.
     *
     * Each draws from the same `rng` as everything else, so adding or removing
     * one changes every subsequent entry in the dataset. That is the point of a
     * seeded generator rather than a defect of it — the output stays
     * byte-identical for a given seed, and `determinism` asserts it.
     */
    if (routineHappensToday(rng, ROUTINE_SKIP_ONE_IN_N)) {
      observations.push(morningEmptying(context));
    }
    if (routineHappensToday(rng, ROUTINE_SKIP_ONE_IN_N)) {
      observations.push(morningDrink(context, MORNING_DRINK_FLUID));
    }
    if (routineHappensToday(rng, WATER_CHASER_SKIP_ONE_IN_N)) {
      observations.push(morningDrink(context, WATER_CHASER_FLUID));
    }
    if (routineHappensToday(rng, ROUTINE_SKIP_ONE_IN_N)) {
      observations.push(firstUrine(context));
    }

    for (let entry = 0; entry < outputEntries; entry += 1) {
      observations.push(outputEntry(context));
    }
    for (let entry = 0; entry < intakeEntries; entry += 1) {
      observations.push(intakeEntry(context));
    }
    for (let entry = 0; entry < urineEntries; entry += 1) {
      observations.push(urineEntry(context));
    }
  }

  return {
    scenario: SCENARIO,
    patient: { id: patientId, oidcSubject: options.oidcSubject },
    profile: {
      id: profileId,
      patientId,
      ostomyType: 'COLOSTOMY',
      surgeryDate,
      measurementSystem: 'metric',
      clientUpdatedAt: options.now,
    },
    observations,
  };
}

interface EntryInput {
  readonly rng: Rng;
  readonly patientId: string;
  readonly timeZone: string;
  readonly options: ScenarioOptions & GeneratorCodes;
  readonly dayOffset: number;
}

function instantFor(input: EntryInput): Date {
  const instant = entryInstant(input.rng, input.options.now, input.dayOffset, input.timeZone);
  assertInPast(SCENARIO, instant, input.options.now, input.dayOffset);
  return instant;
}

/**
 * The habits. Every grouped field is a constant here, which is what makes these
 * one repeated entry rather than ninety similar ones — see `routineInstant`.
 *
 * `estimated: false` is stated rather than drawn: the Measured/Estimated answer
 * is part of the grouping key (ADR-0018), so a routine that sometimes estimated
 * would split into two groups and each might fall below the floor.
 */
function morningEmptying(input: EntryInput): SeedObservation {
  return observationAt({
    rng: input.rng,
    patientId: input.patientId,
    code: STOMA_OUTPUT_LOINC_CODE,
    effectiveDatetime: routineInstantFor(input, MORNING_EMPTYING_HOUR),
    timeZone: input.timeZone,
    valueQuantityValue: MORNING_EMPTYING_ML,
    codes: input.options,
    estimated: false,
  });
}

function morningDrink(input: EntryInput, fluidTypeCode: string): SeedObservation {
  return observationAt({
    rng: input.rng,
    patientId: input.patientId,
    code: FLUID_INTAKE_LOINC_CODE,
    effectiveDatetime: routineInstantFor(input, MORNING_DRINK_HOUR),
    timeZone: input.timeZone,
    valueQuantityValue: MORNING_DRINK_ML,
    codes: input.options,
    estimated: false,
    fluidTypeCode,
  });
}

/**
 * A colour and no volume — the one observation this system stores without a
 * `valueQuantity` (SRS §3.7, AC 12.1 AC2).
 *
 * Seeded as a routine deliberately: it is the Quick-Add widget most likely to be
 * got wrong, because a volumeless entry rendered through the volumetric path
 * shows `0 mL`, which is a reading nobody took.
 */
function firstUrine(input: EntryInput): SeedObservation {
  return observationAt({
    rng: input.rng,
    patientId: input.patientId,
    code: VOIDED_URINE_LOINC_CODE,
    effectiveDatetime: routineInstantFor(input, FIRST_URINE_HOUR),
    timeZone: input.timeZone,
    codes: input.options,
    urineColorCode: FIRST_URINE_COLOR,
  });
}

function routineInstantFor(input: EntryInput, hour: number): Date {
  const instant = routineInstant(
    input.rng,
    input.options.now,
    input.dayOffset,
    input.timeZone,
    hour,
  );
  assertInPast(SCENARIO, instant, input.options.now, input.dayOffset);
  return instant;
}

function outputEntry(input: EntryInput): SeedObservation {
  const { rng } = input;
  const estimated =
    input.options.estimationMethodCode !== null && rng.intBetween(1, ESTIMATED_IN_N) === 1;

  return observationAt({
    rng,
    patientId: input.patientId,
    code: STOMA_OUTPUT_LOINC_CODE,
    effectiveDatetime: instantFor(input),
    timeZone: input.timeZone,
    valueQuantityValue: rng.floatBetween(ENTRY_ML_MIN, ENTRY_ML_MAX, 1).toFixed(1),
    codes: input.options,
    estimated,
  });
}

function intakeEntry(input: EntryInput): SeedObservation {
  const { rng } = input;

  return observationAt({
    rng,
    patientId: input.patientId,
    code: FLUID_INTAKE_LOINC_CODE,
    effectiveDatetime: instantFor(input),
    timeZone: input.timeZone,
    codes: input.options,
    valueQuantityValue: rng.floatBetween(INTAKE_ML_MIN, INTAKE_ML_MAX, 1).toFixed(1),
    fluidTypeCode: FLUIDS[rng.intBetween(0, FLUIDS.length - 1)] ?? 'water',
  });
}

function urineEntry(input: EntryInput): SeedObservation {
  const { rng } = input;

  return observationAt({
    rng,
    patientId: input.patientId,
    code: VOIDED_URINE_LOINC_CODE,
    effectiveDatetime: instantFor(input),
    timeZone: input.timeZone,
    codes: input.options,
    valueQuantityValue: rng.floatBetween(URINE_ML_MIN, URINE_ML_MAX, 1).toFixed(1),
    urineColorCode:
      HEALTHY_URINE_COLORS[rng.intBetween(0, HEALTHY_URINE_COLORS.length - 1)] ?? 'straw',
  });
}
