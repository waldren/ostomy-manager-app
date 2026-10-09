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
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Cached per zone, because constructing an `Intl.DateTimeFormat` dominates the
 * cost and a scenario builds one entry at a time.
 *
 * Not a micro-optimisation: the uncached version made
 * `stableIleostomy.spec.ts`'s 25-seed validation case take 10.4s against
 * vitest's 5s default and turned CI red, on a test #81 already records as
 * flaking near that limit. Two `formatToParts` calls per entry across ~11,000
 * entries is simply too much work to redo.
 */
function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = offsetFormatters.get(timeZone);
  if (cached !== undefined) return cached;

  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  offsetFormatters.set(timeZone, created);
  return created;
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zoneFormatter(timeZone).formatToParts(instant);

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

  /**
   * Walked back an hour at a time until the entry is actually in the past.
   *
   * Not defensive — this fires, and when it does the generator throws and
   * `dev-reset.sh` fails outright. A local hour late in the evening on the most
   * recent day can still be in the FUTURE in UTC: at 02:51Z, 22:00 in
   * `America/Chicago` on day-offset 1 is 03:00Z, nine minutes away. Measured
   * across a UTC day, four hours in twenty-four are affected for a UTC-5
   * scenario zone, and whether it fires on any of them depends on the RNG draw
   * — so it is intermittent, which is what kept it unnoticed.
   *
   * Clamping the hour rather than moving the entry to an earlier day, because a
   * day is load-bearing in both directions here: `assertInPast` guards one end
   * and `assertAfterSurgery` the other, and `new-post-op`'s fourteen-day window
   * sits close enough to its surgery date that shifting an entry a day earlier
   * could cross it. Capping the hour keeps every entry on the day its caller
   * chose.
   *
   * It is also what real data looks like: you cannot have logged something at
   * 22:00 when it is only 21:00. The descent terminates because the loop is
   * bounded by the hour range, and the clash only ever arises when the local
   * clock is late in the evening — so there is always an earlier hour in range
   * that works.
   */
  for (let candidateHour = hour; candidateHour >= hours[0]; candidateHour -= 1) {
    const instant = instantAtLocalHour(day, candidateHour, minute, timeZone);
    if (instant.getTime() < now.getTime()) return instant;
  }

  // Every hour in range is still ahead of `now` on this day. Unreachable for
  // `dayOffset >= 1` with the default range — see above — and a caller passing
  // a narrow late-evening window for today would land here. Returning the
  // earliest hour keeps the failure loud (`assertInPast` throws) rather than
  // silently seeding a future row.
  return instantAtLocalHour(day, hours[0], minute, timeZone);
}

/** One local wall-clock time, resolved through the zone's offset. */
function instantAtLocalHour(day: Date, hour: number, minute: number, timeZone: string): Date {
  const wallClock = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    hour,
    minute,
    0,
    0,
  );

  /**
   * A second pass only when the first one's offset was wrong, which happens
   * only across a DST boundary. Checking is one `formatToParts`; redoing it
   * unconditionally was two per entry for every entry.
   */
  const firstOffset = zoneOffsetMs(new Date(wallClock), timeZone);
  const candidate = new Date(wallClock - firstOffset);
  const settledOffset = zoneOffsetMs(candidate, timeZone);
  return settledOffset === firstOffset ? candidate : new Date(wallClock - settledOffset);
}

/**
 * An entry at the same local hour every day — the timing half of a habit (#114).
 *
 * ## Why any scenario seeds a routine at all
 *
 * Quick-Add (SRS §3.1) generates the dashboard's one-tap widgets from entries
 * the patient has **repeated**: the same code, value, Measured/Estimated answer,
 * fluid type, urine colour and entered system, at least twice in fourteen days.
 * Until this existed, no scenario modelled anyone with a habit, so a freshly
 * seeded stack had nothing for that rule to find — and what it did find was two
 * RNG collisions at 0.1 mL granularity, which the dashboard then described as
 * "you logged this 2 times recently".
 *
 * That is worse than no coverage: the first impression of the feature was a
 * coincidence presented as a routine, and it changed on every reseed, which is
 * the one thing ADR-0009 promises seeded data will not do.
 *
 * ## What a routine entry has to be
 *
 * **Identical in every grouped field**, not merely similar. A volume drawn from
 * a range is a different entry each day no matter how narrow the range, because
 * the grouping key is the exact canonical value — that is deliberate
 * (`quickAddSuggestions.ts`: bucketing 345/350/355 into "350" would put a number
 * on a one-tap button that the patient never recorded). So a routine's value is
 * a constant, and its Measured/Estimated answer is fixed too.
 *
 * The hour is fixed for realism rather than for the rule — Quick-Add does not
 * look at the time of day — but it is what makes the dataset read like a person:
 * a 7am emptying and a 9pm drink, rather than entries scattered uniformly.
 */
export function routineInstant(
  rng: Rng,
  now: Date,
  dayOffset: number,
  timeZone: string,
  hour: number,
): Date {
  return entryInstant(rng, now, dayOffset, timeZone, [hour, hour]);
}

/**
 * Whether a habit happened on this particular day.
 *
 * Nobody does the same thing every single day for ninety days, and a dataset
 * that says they did reads as generated. Skipping roughly one day in
 * `skipOneInN` keeps it human while leaving the fourteen-day window far above
 * Quick-Add's floor of two — `routine.spec.ts` asserts that rather than assuming
 * it, because the margin is what makes the widgets reproducible across reseeds.
 */
export function routineHappensToday(rng: Rng, skipOneInN: number): boolean {
  return rng.intBetween(1, skipOneInN) !== 1;
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
