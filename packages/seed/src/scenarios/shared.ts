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
 * What every scenario needs, in one place.
 *
 * These lived privately inside `stableIleostomy.ts` while it was the only
 * scenario. P3.S5 adds four more, and five copies of a date helper is how the
 * admin surfaces ended up with three different `ZodError` mappings (#100) — so
 * they moved here first, before the new scenarios were written against them.
 *
 * `observationAt` matters more than the date arithmetic. It is the one place
 * `localDate`, `enteredTimezone` and `clientUpdatedAt` are derived, and
 * ADR-0016 is unforgiving about the first: a `local_date` computed any other
 * way seeds rows whose stored day disagrees with their own instant, which is
 * the exact silent failure `toLocalDate` exists to prevent. A scenario that
 * builds its own observation literal can get that wrong without any test
 * noticing, because every assertion about a day would be consistently wrong
 * together.
 */

import { toLocalDate, type MeasurementSystem } from '@ostomy/core/units';

import { deterministicUuid, type Rng } from '../rng.js';
import type { SeedObservation } from '../types.js';

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function atTime(date: Date, hour: number, minute: number): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute, 0, 0),
  );
}

/**
 * An instant `dayOffset` days before `now`, at a plausible waking hour.
 *
 * Waking hours rather than uniform over 24, so a day's chart looks like
 * something a person produced rather than a random process.
 */
export function entryInstant(
  rng: Rng,
  now: Date,
  dayOffset: number,
  hours: readonly [number, number] = [7, 22],
): Date {
  return atTime(
    addDays(now, -dayOffset),
    rng.intBetween(hours[0], hours[1]),
    rng.intBetween(0, 59),
  );
}

/**
 * Refuses an instant at or after `now`.
 *
 * `dayOffset >= 1` already guarantees it, and the guard is kept because it is
 * the Tier 1 rule (`EFFECTIVE_DATE_TIME_IN_FUTURE`) that a future edit to an
 * hour bound would break — and a seeder that generates an invalid row is worse
 * than one that refuses to, because the row reaches the database and then has
 * to be explained.
 */
export function assertInPast(scenario: string, instant: Date, now: Date, dayOffset: number): void {
  if (instant.getTime() >= now.getTime()) {
    throw new Error(
      `${scenario} generated an entry at or after "now" (day offset ${String(dayOffset)}). Tier 1 would reject it as EFFECTIVE_DATE_TIME_IN_FUTURE.`,
    );
  }
}

export interface ObservationAtInput {
  readonly rng: Rng;
  readonly patientId: string;
  readonly code: string;
  readonly effectiveDatetime: Date;
  readonly timeZone: string;
  readonly measurementSystem?: MeasurementSystem;
  /** Omit for a voided-urine entry recorded by colour alone. */
  readonly valueQuantityValue?: string;
  readonly valueQuantityUnit?: 'mL' | 'kg';
  /** The SNOMED estimation code, or null for measured. Must be null with no volume. */
  readonly method?: string | null;
  readonly urineColorCode?: string;
  readonly fluidTypeCode?: string;
}

/**
 * One observation, with the fields no scenario should derive itself.
 *
 * The spread-or-omit shape rather than `field: value ?? null` is deliberate:
 * `exactOptionalPropertyTypes` is on, and more importantly the database's four
 * CHECK constraints distinguish absent from null in ways a scenario author
 * should not have to hold in their head. `method` is forced to null when there
 * is no volume, because that combination is refused by both
 * `validateVolumelessObservation` and the database — better to make it
 * unrepresentable here than to discover it at the writer.
 */
export function observationAt(input: ObservationAtInput): SeedObservation {
  const volumeless = input.valueQuantityValue === undefined;

  return {
    id: deterministicUuid(input.rng),
    patientId: input.patientId,
    code: input.code,
    valueQuantityValue: input.valueQuantityValue ?? null,
    valueQuantityUnit: volumeless ? null : (input.valueQuantityUnit ?? 'mL'),
    effectiveDatetime: input.effectiveDatetime,
    method: volumeless ? null : (input.method ?? null),
    enteredMeasurementSystem: input.measurementSystem ?? 'metric',
    enteredTimezone: input.timeZone,
    // Derived from the SAME shared helper the API and the phone use (ADR-0016).
    localDate: toLocalDate(input.effectiveDatetime, input.timeZone),
    clientUpdatedAt: input.effectiveDatetime,
    ...(input.urineColorCode !== undefined ? { urineColorCode: input.urineColorCode } : {}),
    ...(input.fluidTypeCode !== undefined ? { fluidTypeCode: input.fluidTypeCode } : {}),
  };
}
