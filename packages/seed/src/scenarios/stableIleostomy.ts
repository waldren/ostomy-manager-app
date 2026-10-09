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

import { createRng, deterministicUuid, type Rng } from '../rng.js';
import {
  STOMA_OUTPUT_LOINC_CODE,
  type ScenarioOptions,
  type SeedDataset,
  type SeedObservation,
} from '../types.js';

/**
 * `stable-ileostomy` — "well-controlled output over ~90 days; the baseline
 * case" (`docs/deployment-development.md`).
 *
 * This is the scenario every other one is read against, so its job is to be
 * unremarkable: an ileostomy patient three months post-op, logging four to
 * six entries a day, each a plausible volume, totalling a plausible day.
 *
 * ## What "valid by construction" means here, concretely
 *
 * Every generated entry must pass Tier 1 (`docs/deployment-development.md`,
 * ADR-0009). The constraints that actually bite, each enforced by the bounds
 * below rather than by hoping:
 *
 * - **Positive, and representable.** Volumes are drawn strictly above zero
 *   and rounded to 4 decimal places, because `DECIMAL(12,4)` is what the
 *   column holds and more precision is `VALUE_EXCEEDS_MAX_PRECISION`.
 * - **Never in the future.** Every `effectiveDateTime` is strictly before
 *   `now`; a future one beyond the skew allowance is
 *   `EFFECTIVE_DATE_TIME_IN_FUTURE`.
 * - **Never before the surgery date.** The window starts after it, because
 *   an entry earlier than surgery is `EFFECTIVE_DATE_TIME_BEFORE_SURGERY`.
 * - **The Measured/Estimated choice is always made.** `method` is never
 *   left unset — an absent selection is `METHOD_REQUIRED`.
 *
 * ## And what it must NOT do
 *
 * Trip a Tier 2 soft warning. That is `validation-edge-cases`' job (P3.S5),
 * and a baseline dataset that warns on ordinary days would make the warning
 * unreadable in the one scenario built to exercise it. The per-entry cap is
 * kept well under the 2,000 mL default for that reason — and note the
 * threshold is admin-configurable, so `assertNoTier2Warnings` in `../index.ts`
 * checks the generated data against the *actual* configured value rather
 * than trusting this bound.
 */

/** Distinct from any other scenario's, so two scenarios in one database do not generate colliding ids. */
const DEFAULT_SEED = 0x51ab1e; // "stable"

const DEFAULT_TIME_ZONE = 'America/Chicago';

/** ~90 days of history, per the scenario description. */
const HISTORY_DAYS = 90;

const SURGERY_DAYS_AGO = 104;

/**
 * A well-controlled ileostomy runs roughly 600–1,200 mL/day total. Four to
 * six entries a day at 120–320 mL lands in that band without ever
 * approaching the 2,000 mL single-entry soft warning.
 */
const ENTRIES_PER_DAY_MIN = 4;
const ENTRIES_PER_DAY_MAX = 6;
const ENTRY_ML_MIN = 120;
const ENTRY_ML_MAX = 320;

/**
 * Roughly one entry in six is estimated rather than measured.
 *
 * Not cosmetic: AC 2.2 AC2 requires history to visually distinguish the two,
 * and a dataset where every entry is Measured cannot demonstrate that at all.
 * `method` is the only stored representation of the choice (ADR-0018), so
 * this is the only way a badge has anything to render.
 */
const ESTIMATED_IN_N = 6;

/**
 * A morning emptying at the same volume most days (#114).
 *
 * This scenario emits stoma output and nothing else, so it can seed exactly one
 * of Quick-Add's three paths — the volumetric one. That is not a gap to fix
 * here: the alternative is giving the baseline intake and urine, which would
 * change what "the scenario every other one is read against" means. The other
 * two paths are seeded in `colostomy-baseline`, which already models a patient
 * who logs all three, and `scripts/dev-reset.sh` seeds that one by default for
 * exactly this reason.
 *
 * What it does fix is the thing a routine is for: before it, the most repeated
 * entry in ninety days of history was an RNG collision at 0.1 mL granularity,
 * which the dashboard described as "you logged this 2 times recently" and which
 * changed on every reseed.
 */
const ROUTINE_SKIP_ONE_IN_N = 7;
const MORNING_EMPTYING_HOUR = 7;
const MORNING_EMPTYING_ML = '240.0';

export function generateStableIleostomy(options: ScenarioOptions & GeneratorCodes): SeedDataset {
  const rng = createRng(options.seed ?? DEFAULT_SEED);
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;

  const patientId = deterministicUuid(rng);
  const profileId = deterministicUuid(rng);

  const surgeryDate = startOfUtcDay(addDays(options.now, -SURGERY_DAYS_AGO));

  const observations: SeedObservation[] = [];
  // Oldest first, so ids and timestamps advance together and a reader
  // scanning the output sees the history in the order it happened.
  for (let dayOffset = HISTORY_DAYS; dayOffset >= 1; dayOffset -= 1) {
    const entriesToday = rng.intBetween(ENTRIES_PER_DAY_MIN, ENTRIES_PER_DAY_MAX);

    // The habit first, so it sits at the start of the day it belongs to. It is
    // one of `entriesToday`'s siblings rather than an extra, which keeps the
    // daily total inside the well-controlled band this scenario asserts.
    if (routineHappensToday(rng, ROUTINE_SKIP_ONE_IN_N)) {
      observations.push(
        morningEmptying({
          rng,
          patientId,
          now: options.now,
          dayOffset,
          timeZone,
          codes: options,
        }),
      );
    }

    for (let entry = 0; entry < entriesToday; entry += 1) {
      observations.push(
        generateEntry({
          rng,
          patientId,
          now: options.now,
          dayOffset,
          timeZone,
          codes: options,
        }),
      );
    }
  }

  return {
    scenario: 'stable-ileostomy',
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
 * The habit. Every grouped field is a constant, which is what makes these one
 * repeated entry rather than ninety similar ones — see `routineInstant`.
 *
 * `estimated: false` is stated rather than drawn, because the Measured/Estimated
 * answer is part of the grouping key (ADR-0018): a routine that sometimes
 * estimated would split into two groups, and each might fall below the floor of
 * two that Quick-Add requires.
 */
function morningEmptying(input: {
  rng: Rng;
  patientId: string;
  now: Date;
  dayOffset: number;
  timeZone: string;
  codes: GeneratorCodes;
}): SeedObservation {
  const effectiveDatetime = routineInstant(
    input.rng,
    input.now,
    input.dayOffset,
    input.timeZone,
    MORNING_EMPTYING_HOUR,
  );
  assertInPast('stable-ileostomy', effectiveDatetime, input.now, input.dayOffset);

  return observationAt({
    rng: input.rng,
    patientId: input.patientId,
    code: STOMA_OUTPUT_LOINC_CODE,
    effectiveDatetime,
    timeZone: input.timeZone,
    valueQuantityValue: MORNING_EMPTYING_ML,
    codes: input.codes,
    estimated: false,
  });
}

function generateEntry(input: {
  rng: Rng;
  patientId: string;
  now: Date;
  dayOffset: number;
  timeZone: string;
  codes: GeneratorCodes;
}): SeedObservation {
  const { rng } = input;

  const effectiveDatetime = entryInstant(rng, input.now, input.dayOffset, input.timeZone);
  assertInPast('stable-ileostomy', effectiveDatetime, input.now, input.dayOffset);

  const estimated = rng.intBetween(1, ESTIMATED_IN_N) === 1;

  /**
   * Built by `observationAt` rather than as a literal here, which is what this
   * file did until review pointed out that `shared.ts` claimed the helpers had
   * MOVED when they had only been copied.
   *
   * The consequence was live, not theoretical: this scenario kept writing
   * `method = NULL` for a measured entry while the four new ones were fixed to
   * write |Measured|, so the baseline dataset was the one holding the shape
   * ADR-0018 reserves for an observation with no toggle. That is CLAUDE.md's
   * field-drop pattern exactly — add a column to the shared builder and four
   * scenarios get it while the oldest silently does not.
   */
  return observationAt({
    rng,
    patientId: input.patientId,
    code: STOMA_OUTPUT_LOINC_CODE,
    effectiveDatetime,
    timeZone: input.timeZone,
    // One decimal place: real enough to prove the column is not an integer
    // (ADR-0005), shallow enough to read in a demo.
    valueQuantityValue: rng.floatBetween(ENTRY_ML_MIN, ENTRY_ML_MAX, 1).toFixed(1),
    codes: input.codes,
    estimated,
  });
}
