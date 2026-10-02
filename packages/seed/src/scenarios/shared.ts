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
 * admin surfaces ended up with three different `ZodError` mappings (#100).
 *
 * **They were copied here, not moved, and this comment claimed otherwise until
 * review caught it.** `stableIleostomy.ts` kept its own copies and its own
 * hand-written observation literal, which had a live consequence rather than a
 * stylistic one: when the four new scenarios were fixed to write |Measured| on
 * a measured row, the baseline went on writing `NULL` — the encoding ADR-0018
 * reserves for an observation with no toggle. CLAUDE.md's field-drop pattern,
 * exactly. It is migrated now, and this paragraph stays as the reason the next
 * person should check rather than trust a claim like the one it replaced.
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
import { VOIDED_URINE_LOINC_CODE, type SeedObservation } from '../types.js';

/**
 * The two terminology codes a generator needs, injected rather than imported so
 * this package never holds a stale copy of either (ADR-0018). One type, so a
 * third code added later reaches all five scenarios at once.
 */
export interface GeneratorCodes {
  readonly estimationMethodCode: string | null;
  readonly measuredMethodCode: string | null;
}

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
 * What `instant` is offset from UTC in `timeZone`, in milliseconds.
 *
 * Via `Intl`, because the alternative is a table of rules that goes stale. Used
 * only to place a generated entry at a local hour.
 */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const part = (type: string): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour') % 24,
    part('minute'),
    part('second'),
  );
  return asIfUtc - instant.getTime();
}

/**
 * An instant `dayOffset` days before `now`, at a plausible waking hour **in the
 * entry's own timezone**.
 *
 * Waking hours rather than uniform over 24, so a day's chart looks like
 * something a person produced rather than a random process.
 *
 * ## The hour is local, and the first version's was not
 *
 * It applied the hour through `Date.UTC`, so in `America/Chicago` every entry
 * landed between 02:00 and 17:59 local — a third of them between 2 a.m. and
 * 6 a.m., and **none after 6 p.m.** The comment above claimed a plausible
 * waking hour and the code produced the opposite.
 *
 * Worse, it made ADR-0016 untestable with seeded data. With local hours capped
 * at 17:59, **no row's local date ever differed from its UTC date** — 0 of
 * 2,304 — so `invariants.spec.ts`'s assertion that `localDate` comes from
 * `toLocalDate` compared the helper against itself, and a mutation replacing
 * that call with `toISOString().slice(0, 10)` left the whole suite green. A
 * local day straddling two UTC days is the case `apps/web` fetches a wider
 * window for; nothing seeded exercised it.
 *
 * Drawing the hour locally fixes both: local evenings now exist, and a local
 * evening in a western zone IS the next UTC day.
 */
export function entryInstant(
  rng: Rng,
  now: Date,
  dayOffset: number,
  timeZone: string,
  hours: readonly [number, number] = [7, 22],
): Date {
  const day = addDays(now, -dayOffset);
  const hour = rng.intBetween(hours[0], hours[1]);
  const minute = rng.intBetween(0, 59);

  const wallClock = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    hour,
    minute,
    0,
    0,
  );

  // Two passes, because the offset at the guessed instant can itself differ
  // from the offset at the corrected one across a DST boundary.
  let instant = new Date(wallClock - zoneOffsetMs(new Date(wallClock), timeZone));
  instant = new Date(wallClock - zoneOffsetMs(instant, timeZone));
  return instant;
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
  /**
   * The two terminology codes, required — which is the point.
   *
   * An earlier version of this took an optional `method` string and let each
   * call site decide. Review found the result: 2,128 volumetric rows carrying
   * `method = NULL`, which ADR-0018 as amended reserves for an observation with
   * **no toggle at all** (weight, resting heart rate), while the application
   * writes `258104002` |Measured| for a measured entry. Intake and urine rows
   * were the worst of it — they never went near the `method` branch, so they
   * could not have been fixed by a careful author remembering.
   *
   * Required and non-optional, so a volumetric row without a qualifier is a
   * compile error rather than something a reviewer has to notice.
   */
  readonly codes: GeneratorCodes;
  /** True for an estimated entry. Ignored where there is no volume to qualify. */
  readonly estimated?: boolean;
  readonly urineColorCode?: string;
  readonly fluidTypeCode?: string;
}

/**
 * One observation, with the fields no scenario should derive itself.
 *
 * The spread-or-omit shape rather than `field: value ?? null` is deliberate:
 * `exactOptionalPropertyTypes` is on, and more importantly the database's four
 * CHECK constraints distinguish absent from null in ways a scenario author
 * should not have to hold in their head.
 *
 * **Two of the four are structurally impossible here; two are merely checked.**
 * An earlier version of this comment claimed all four were "unrepresentable",
 * and review showed that was an overclaim: the volume/unit pairing and the
 * `method`-needs-a-volume rule are enforced by construction below, but a
 * caller could still ask for a volumeless STOMA OUTPUT row, or a colour on one
 * — both of which pass every rule in this package and then die at the writer
 * on a Postgres constraint name. `invariants.spec.ts` catches them for the five
 * scenarios that exist; the throws below catch them for the next author, at the
 * point of the mistake rather than at the end of a seeding run.
 */
export function observationAt(input: ObservationAtInput): SeedObservation {
  const volumeless = input.valueQuantityValue === undefined;

  if (volumeless && input.code !== VOIDED_URINE_LOINC_CODE) {
    throw new Error(
      `observationAt: only ${VOIDED_URINE_LOINC_CODE} (voided urine) may omit its volume, not ${input.code}. The database's observations_value_or_urine_color CHECK would refuse this row.`,
    );
  }
  if (volumeless && input.urineColorCode === undefined) {
    throw new Error(
      'observationAt: a voided-urine entry with no volume must carry a colour — that is what makes it a valid observation rather than an empty one (SRS §3.7, AC 12.1 AC2).',
    );
  }
  if (input.urineColorCode !== undefined && input.code !== VOIDED_URINE_LOINC_CODE) {
    throw new Error(
      `observationAt: a urine colour belongs only to ${VOIDED_URINE_LOINC_CODE}, not ${input.code}. The database's observations_urine_color_code_only CHECK would refuse this row.`,
    );
  }

  return {
    id: deterministicUuid(input.rng),
    patientId: input.patientId,
    code: input.code,
    valueQuantityValue: input.valueQuantityValue ?? null,
    valueQuantityUnit: volumeless ? null : (input.valueQuantityUnit ?? 'mL'),
    effectiveDatetime: input.effectiveDatetime,
    /**
     * Null if and only if there is no volume.
     *
     * Three states, which are easy to collapse into two: an estimated entry
     * carries the estimation code, a measured entry carries |Measured|, and an
     * entry with nothing to qualify carries null. The `?? null` fallbacks apply
     * only where a code is unresolved, which is the pre-ADR-0018 reading and
     * the one case where a null on a volumetric row is still honest.
     */
    method: volumeless
      ? null
      : input.estimated === true
        ? (input.codes.estimationMethodCode ?? input.codes.measuredMethodCode ?? null)
        : (input.codes.measuredMethodCode ?? null),
    enteredMeasurementSystem: input.measurementSystem ?? 'metric',
    enteredTimezone: input.timeZone,
    // Derived from the SAME shared helper the API and the phone use (ADR-0016).
    localDate: toLocalDate(input.effectiveDatetime, input.timeZone),
    clientUpdatedAt: input.effectiveDatetime,
    ...(input.urineColorCode !== undefined ? { urineColorCode: input.urineColorCode } : {}),
    ...(input.fluidTypeCode !== undefined ? { fluidTypeCode: input.fluidTypeCode } : {}),
  };
}
