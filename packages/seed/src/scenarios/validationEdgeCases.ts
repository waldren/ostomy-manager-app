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
 * Entries that legitimately trip a Tier 2 soft warning, and entries that very
 * nearly do.
 *
 * `deployment-development.md`: "Entries that legitimately trip Tier 2 soft
 * warnings (§3.8), so warning behavior is testable without hand-crafting data."
 * It is also the one scenario the same document exempts from "valid by
 * construction", because tripping warnings is the point.
 *
 * ## The word doing the work is "legitimately"
 *
 * Every row here passes **Tier 1**. That is not a technicality — it is the
 * whole distinction §3.8 is built on, and the easiest thing to get wrong when
 * writing deliberately-unusual data. A row that trips Tier 1 is rejected and
 * never reaches a warning path, so a scenario full of negative volumes and
 * future timestamps would exercise nothing at all. `assertScenarioIsValid`
 * still runs over this dataset and still refuses to write it if any row would
 * be blocked.
 *
 * SRS §3.8 is unusually firm about why these rows have to exist: "a genuine
 * 2,500 mL output day is precisely the data point the care team most needs to
 * see", and a warning "never blocks and never scolds". The failure this
 * scenario guards against is a future change that promotes the soft warning to
 * a block — which `admin-threshold-wire.ts` already refuses at the API, and
 * which this dataset would surface the moment a demo stopped being able to save
 * these entries.
 *
 * ## Both sides of the line, on purpose
 *
 * Roughly a third of the days carry an over-threshold entry; the rest sit just
 * under it. A dataset of nothing but warnings cannot show that the threshold
 * has a *shape* — it looks identical to a system that warns on everything,
 * which is the failure mode #93's settable floor exists to prevent. The
 * just-under entries are what make the warning legible as a boundary.
 *
 * ## It does not hardcode the threshold
 *
 * `OVER_THRESHOLD_ML` is above the migration-seeded 2,000 mL default, and that
 * default is admin-configurable — so this scenario asserts nothing about the
 * number. Its spec checks the dataset against the thresholds it is handed, via
 * `findTier2Warnings`, which is the same injection ADR-0009 requires everywhere
 * else. If an admin raises the bound past these values the warnings stop, and
 * that is correct behaviour rather than a broken scenario.
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
  startOfUtcDay,
  type GeneratorCodes,
} from './shared.js';

const SCENARIO = 'validation-edge-cases';
// Arbitrary but distinct — see `highOutputDehydration.ts` on why that matters.
const DEFAULT_SEED = 0xed6ec5;
const DEFAULT_TIME_ZONE = 'America/Chicago';

const HISTORY_DAYS = 21;
const SURGERY_DAYS_AGO = 150;

/**
 * Above the seeded 2,000 mL soft warning, and only just — which is the honest
 * range and not the one this file shipped with.
 *
 * It was 2,300-2,800, and review was right to call that physically implausible
 * for a SINGLE emptying: a drainable pouch holds 400-900 mL and even an
 * overnight drainage bag tops out around 1,500-2,000. That is the same
 * reasoning used to set #93's settable floor at 1,000 mL, so this file was
 * contradicting a bound chosen in the same sprint.
 *
 * It also exposes a real tension worth recording rather than papering over:
 * SRS AC 2.1 AC2 fixes the single-entry default at 2,000 mL, which sits at the
 * very top of what one emptying can physically be. Tripping it therefore
 * requires an unusually large night-bag collection — plausible, but rare. A
 * value just over the line is the only *legitimate* way to trip it, and
 * "legitimately" is the word the scenario's own purpose turns on.
 */
const OVER_THRESHOLD_ML_MIN = 2050;
const OVER_THRESHOLD_ML_MAX = 2400;

/** Just under, so the boundary is visible from both sides. */
const UNDER_THRESHOLD_ML_MIN = 1600;
const UNDER_THRESHOLD_ML_MAX = 1950;

/** Ordinary entries, so the unusual ones are not the entire history. */
const ORDINARY_ML_MIN = 150;
const ORDINARY_ML_MAX = 400;
const ORDINARY_ENTRIES_MIN = 3;
const ORDINARY_ENTRIES_MAX = 5;

/**
 * Roughly a third of days carry an unusual entry. The rest are ordinary.
 *
 * This constant existed and was not used as a gate: the generator appended an
 * unusual entry to EVERY day — the over-threshold one on a third, a
 * just-under-threshold one on the other two thirds. Mean daily output came out
 * at 3,168 mL against ~375 mL of logged intake, a net balance near -2,800 mL
 * every day for three weeks, which is worse than `high-output-dehydration`'s
 * worst day and makes any §3.7 or §3.9 view pegged at maximum alarm. The
 * docstring said "roughly a third of the days" throughout; the code did not.
 */
const UNUSUAL_DAY_IN_N = 3;

/**
 * Four decimal places exactly — the most the canonical `DECIMAL(12,4)` column
 * can hold. One more is `VALUE_EXCEEDS_MAX_PRECISION`, a Tier 1 block, so this
 * is the boundary value that proves the column's scale is respected rather than
 * approached. It is the shape an imperial conversion produces before rounding:
 * `ozToMl(80)` is 2365.882365, which un-rounded trips Tier 1.
 */
const MAX_PRECISION_ML = '1234.5678';

export function generateValidationEdgeCases(
  options: ScenarioOptions & GeneratorCodes,
): SeedDataset {
  const rng = createRng(options.seed ?? DEFAULT_SEED);
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  const patientId = deterministicUuid(rng);
  const profileId = deterministicUuid(rng);
  const surgeryDate = startOfUtcDay(addDays(options.now, -SURGERY_DAYS_AGO));

  const observations: SeedObservation[] = [];

  for (let dayOffset = HISTORY_DAYS; dayOffset >= 1; dayOffset -= 1) {
    const context = { rng, patientId, timeZone, options, dayOffset };

    // Drawn once, not in the loop condition — see `colostomyBaseline.ts`.
    const ordinaryEntries = rng.intBetween(ORDINARY_ENTRIES_MIN, ORDINARY_ENTRIES_MAX);
    for (let entry = 0; entry < ordinaryEntries; entry += 1) {
      observations.push(
        outputEntry(context, rng.floatBetween(ORDINARY_ML_MIN, ORDINARY_ML_MAX, 1).toFixed(1)),
      );
    }

    // One unusual entry on roughly a third of days, and nothing added on the
    // rest — so most days are an ordinary history and the boundary is legible
    // against it. Over and just-under alternate within those days, because a
    // dataset of only warnings cannot show the bound as a boundary.
    if (rng.intBetween(1, UNUSUAL_DAY_IN_N) === 1) {
      const overThreshold = rng.intBetween(1, 2) === 1;
      observations.push(
        outputEntry(
          context,
          overThreshold
            ? rng.floatBetween(OVER_THRESHOLD_ML_MIN, OVER_THRESHOLD_ML_MAX, 1).toFixed(1)
            : rng.floatBetween(UNDER_THRESHOLD_ML_MIN, UNDER_THRESHOLD_ML_MAX, 1).toFixed(1),
        ),
      );
    }

    /**
     * Enough intake for the balance to be plausible, not just present.
     *
     * One entry a day left ~350 mL against ~1,900 mL of output — a deficit near
     * -1,500 mL every day for three weeks, which pegs any §3.7 or §3.9 view at
     * maximum alarm and makes this useless as the dataset someone reaches for
     * when testing WARNING behaviour. The warnings should be the unusual thing
     * here; everything else should look ordinary.
     */
    const intakeEntries = rng.intBetween(4, 6);
    for (let entry = 0; entry < intakeEntries; entry += 1) {
      observations.push(intakeEntry(context));
    }
  }

  // The precision boundary, once. A value rather than a range because the point
  // is the exact scale of the column.
  observations.push(
    outputEntry({ rng, patientId, timeZone, options, dayOffset: 2 }, MAX_PRECISION_ML),
  );

  // A voided-urine entry with a colour and no volume, which is the only
  // observation this system stores with no `valueQuantity` (P3.S2). Included
  // here as well as in `high-output-dehydration` because this is the dataset
  // someone reaches for when testing validation behaviour, and the volumeless
  // path has its own rule set — `validateVolumelessObservation`, which refuses
  // a Measured/Estimated qualifier on an entry with nothing to qualify.
  observations.push(
    observationAt({
      rng,
      patientId,
      code: VOIDED_URINE_LOINC_CODE,
      effectiveDatetime: instantFor({ rng, patientId, timeZone, options, dayOffset: 3 }),
      timeZone,
      codes: options,
      urineColorCode: 'dark_yellow',
    }),
  );

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

function outputEntry(input: EntryInput, valueQuantityValue: string): SeedObservation {
  return observationAt({
    rng: input.rng,
    patientId: input.patientId,
    code: STOMA_OUTPUT_LOINC_CODE,
    effectiveDatetime: instantFor(input),
    timeZone: input.timeZone,
    valueQuantityValue,
    codes: input.options,
    // Measured throughout. An estimated qualifier on a 2,500 mL entry invites
    // the reading that the warning fired because the number was guessed, when
    // §3.8's position is that a real 2,500 mL day is the data point the care
    // team most needs — the warning must be about the value, not its provenance.
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
    valueQuantityValue: rng.floatBetween(250, 500, 1).toFixed(1),
    fluidTypeCode: 'water',
  });
}
