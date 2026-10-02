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
 * Two weeks after surgery, logging sporadically.
 *
 * `deployment-development.md`: "Two weeks since surgery, sparse entries;
 * exercises early post-op default ranges and the §3.0 minimum-onboarding path."
 *
 * ## The sparseness is the feature
 *
 * Every other scenario produces a tidy daily history, and a tidy history hides
 * a whole class of defect. This one has **days with no entries at all**, which
 * is what a real first fortnight looks like: a patient recovering from
 * abdominal surgery does not log six times a day. That makes it the dataset
 * that exercises what the other scenarios cannot —
 *
 * - a day with no output at all, where a daily total is absent rather than zero
 *   (the same distinction CLAUDE.md draws for a missing volume, one level up);
 * - a §3.7 balance with output logged and no intake, which the web view has to
 *   say is not a complete balance rather than render a large negative number
 *   that reads as a severe deficit;
 * - §3.9's early post-op default ranges, which are keyed to days since surgery
 *   and are the only ranges this patient can have — fourteen days of history is
 *   not enough to adapt anything from.
 *
 * ## Why the surgery date is the load-bearing field
 *
 * It is the Tier 1 lower timestamp bound (SRS §3.8: "entry timestamps earlier
 * than the recorded surgery/ostomy creation date"), and here it sits only
 * fourteen days back, so the window in which an entry is valid at all is
 * narrow. That makes this the scenario where an off-by-one in a day offset
 * fails loudly instead of landing harmlessly inside ninety days of history —
 * which is why `assertInPast` is not the only guard below.
 */

import {
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
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

const SCENARIO = 'new-post-op';
// Arbitrary but distinct — see `highOutputDehydration.ts` on why that matters.
const DEFAULT_SEED = 0x0ffce5;
const DEFAULT_TIME_ZONE = 'America/Chicago';

const SURGERY_DAYS_AGO = 14;
/**
 * One day short of the surgery date, deliberately.
 *
 * An entry ON the surgery date is valid, but generating history right up to the
 * boundary would mean a future change to the hour range could push an entry
 * before it and trip `ENTRY_BEFORE_SURGERY_DATE`. The margin is one day because
 * the entry hour can be as early as 07:00 and the surgery date is midnight UTC.
 */
const HISTORY_DAYS = SURGERY_DAYS_AGO - 1;

/**
 * Roughly one day in three has nothing logged at all.
 *
 * The comment said "two days in five" and the code said `5 / 2`, which
 * `Math.round` turns into 3 — so the prose and the behaviour disagreed. Written
 * as the integer it actually is.
 */
const SILENT_DAY_IN_N = 3;

const ENTRIES_PER_DAY_MIN = 1;
const ENTRIES_PER_DAY_MAX = 3;

/**
 * Per entry these run higher and more variable than a settled stoma, which is
 * what early post-op output does and why §3.9 keys its defaults to days since
 * surgery rather than to one population range.
 *
 * **The DAILY total is nonetheless low — about 600 mL against the 1,200-2,000
 * a real fortnight-old ileostomy produces — and that is the scenario, not a
 * mistake.** This comment used to imply the opposite, which review caught: with
 * 1-3 entries logged on two days in three, the dataset holds roughly a third of
 * what the patient actually passed. A partially-logged history is what sparse
 * MEANS, and it is the case §3.7 has to survive — a balance computed from part
 * of a day is not a small error, it is a reassuring number drawn from the wrong
 * denominator.
 *
 * Against an early post-op §3.9 range this patient therefore reads as
 * under-draining. That is a true thing about the data and exactly what someone
 * testing the suggestion path should see, so long as they know why.
 */
const ENTRY_ML_MIN = 180;
const ENTRY_ML_MAX = 480;

/** Intake logged on fewer days still than output: the thing patients forget first. */
const INTAKE_DAY_IN_N = 3;
const INTAKE_ML_MIN = 150;
const INTAKE_ML_MAX = 350;

const ESTIMATED_IN_N = 3;

export function generateNewPostOp(options: ScenarioOptions & GeneratorCodes): SeedDataset {
  const rng = createRng(options.seed ?? DEFAULT_SEED);
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const patientId = deterministicUuid(rng);
  const profileId = deterministicUuid(rng);
  const surgeryDate = startOfUtcDay(addDays(options.now, -SURGERY_DAYS_AGO));

  const observations: SeedObservation[] = [];

  for (let dayOffset = HISTORY_DAYS; dayOffset >= 1; dayOffset -= 1) {
    if (rng.intBetween(1, SILENT_DAY_IN_N) === 1) continue;

    const entriesToday = rng.intBetween(ENTRIES_PER_DAY_MIN, ENTRIES_PER_DAY_MAX);
    for (let entry = 0; entry < entriesToday; entry += 1) {
      observations.push(outputEntry({ rng, patientId, timeZone, options, dayOffset, surgeryDate }));
    }

    if (rng.intBetween(1, INTAKE_DAY_IN_N) === 1) {
      observations.push(intakeEntry({ rng, patientId, timeZone, options, dayOffset, surgeryDate }));
    }
  }

  return {
    scenario: SCENARIO,
    patient: { id: patientId, oidcSubject: options.oidcSubject },
    profile: {
      id: profileId,
      patientId,
      ostomyType: 'ILEOSTOMY',
      surgeryDate,
      // Imperial, so this is also the scenario that proves ADR-0004's
      // render-time conversion against real history: the stored values are
      // canonical mL regardless, and nothing rewrites them when the preference
      // changes. Every other scenario is metric, which would have left that
      // path unexercised by seeded data entirely.
      measurementSystem: 'imperial',
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
  readonly surgeryDate: Date;
}

/**
 * The guard the other scenarios do not need.
 *
 * With ninety days of history, an entry can never approach the surgery date. In
 * a fourteen-day window it can, and `ENTRY_BEFORE_SURGERY_DATE` is a Tier 1
 * block — so the generator refuses rather than handing the writer a row the
 * application would reject.
 */
function assertAfterSurgery(instant: Date, surgeryDate: Date, dayOffset: number): void {
  if (instant.getTime() < surgeryDate.getTime()) {
    throw new Error(
      `${SCENARIO} generated an entry before the surgery date (day offset ${String(dayOffset)}). Tier 1 would reject it as ENTRY_BEFORE_SURGERY_DATE.`,
    );
  }
}

function instantFor(input: EntryInput): Date {
  const instant = entryInstant(input.rng, input.options.now, input.dayOffset, input.timeZone);
  assertInPast(SCENARIO, instant, input.options.now, input.dayOffset);
  assertAfterSurgery(instant, input.surgeryDate, input.dayOffset);
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
    // Estimated more often than a settled patient: a fortnight in, nobody has a
    // measuring jug routine yet. ADR-0018's qualifier is on the row either way.
    codes: input.options,
    estimated,
    measurementSystem: 'imperial',
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
    fluidTypeCode: 'water',
    measurementSystem: 'imperial',
  });
}
