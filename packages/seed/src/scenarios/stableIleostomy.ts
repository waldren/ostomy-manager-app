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

import { toLocalDate } from '@ostomy/core/units';

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

export function generateStableIleostomy(
  options: ScenarioOptions & { readonly estimationMethodCode: string | null },
): SeedDataset {
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
    for (let entry = 0; entry < entriesToday; entry += 1) {
      observations.push(
        generateEntry({
          rng,
          patientId,
          now: options.now,
          dayOffset,
          timeZone,
          estimationMethodCode: options.estimationMethodCode,
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

function generateEntry(input: {
  rng: Rng;
  patientId: string;
  now: Date;
  dayOffset: number;
  timeZone: string;
  estimationMethodCode: string | null;
}): SeedObservation {
  const { rng } = input;

  // Spread across waking hours rather than uniformly over 24, so a day's
  // chart looks like something a person produced. 07:00–23:00.
  const hour = rng.intBetween(7, 22);
  const minute = rng.intBetween(0, 59);

  const effectiveDatetime = atTime(addDays(input.now, -input.dayOffset), hour, minute);

  // `dayOffset >= 1` already guarantees this, but the check is kept because
  // it is the Tier 1 rule that would otherwise fail on a future edit to the
  // hour bounds — and a seeder that generates an invalid row is worse than
  // one that refuses to.
  if (effectiveDatetime.getTime() >= input.now.getTime()) {
    throw new Error(
      `stable-ileostomy generated an entry at or after "now" (day offset ${String(input.dayOffset)}). Tier 1 would reject it as EFFECTIVE_DATE_TIME_IN_FUTURE.`,
    );
  }

  const estimated = input.estimationMethodCode !== null && rng.intBetween(1, ESTIMATED_IN_N) === 1;

  return {
    id: deterministicUuid(rng),
    patientId: input.patientId,
    code: STOMA_OUTPUT_LOINC_CODE,
    // One decimal place: real enough to prove the column is not an integer
    // (ADR-0005), shallow enough to read in a demo.
    valueQuantityValue: rng.floatBetween(ENTRY_ML_MIN, ENTRY_ML_MAX, 1).toFixed(1),
    valueQuantityUnit: 'mL',
    effectiveDatetime,
    method: estimated ? input.estimationMethodCode : null,
    enteredMeasurementSystem: 'metric',
    enteredTimezone: input.timeZone,
    // Derived from the SAME shared helper the API and the phone use
    // (ADR-0016). Computing it any other way here would seed rows whose
    // stored day disagrees with their own instant — the silent failure
    // that helper exists to prevent.
    localDate: toLocalDate(effectiveDatetime, input.timeZone),
    clientUpdatedAt: effectiveDatetime,
  };
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function atTime(date: Date, hour: number, minute: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, 0, 0),
  );
}
