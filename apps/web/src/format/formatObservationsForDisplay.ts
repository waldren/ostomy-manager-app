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
  convertVolumeForDisplay,
  formatDailyVolumeTotalForDisplay,
  isResolvableTimeZone,
  toLocalDate,
  unitsForMeasurementSystem,
  type CanonicalVolume,
  type DisplayVolume,
  type MeasurementSystemUnits,
} from '@ostomy/core/units';
import type { Observation } from '@ostomy/core/api-client';
import {
  countsTowardDailyNetFluidBalance,
  isUrineOutputSignal,
  netDailyFluidBalanceMl,
  NET_FLUID_BALANCE_INTAKE_LOINC_CODES,
  NET_FLUID_BALANCE_OUTPUT_LOINC_CODES,
} from '@ostomy/core/hydration';
import { MEASURED_METHOD_CODE } from '@ostomy/core/validation';

export type EntryMethod = 'measured' | 'estimated';

/**
 * The canonical mL this observation records, or `undefined` when it records
 * none.
 *
 * `valueQuantity` became conditional at P3.S2: a voided-urine entry may carry
 * a colour instead of an amount (SRS §3.7, AC 12.1 AC2), and §7.2 has the
 * server OMIT the key rather than send `null` or `0` for it.
 *
 * **Never `?? 0`.** That is the one-line version of the defect the whole
 * nullable-volume design exists to prevent: a missing amount is not a void of
 * zero, and every figure on this page — the daily total, the balance, the
 * chart's scale — would absorb the fabricated reading and show a confidently
 * wrong number with nothing on screen to suggest it. `undefined` forces each
 * caller to say what it does with an entry that has no amount, which for all
 * three of them is "leave it out of the arithmetic".
 */
function volumeMlOf(observation: Observation): number | undefined {
  return observation.valueQuantity?.value;
}

export interface DisplayOutputEntry {
  readonly id: string;
  readonly effectiveDateTime: Date;
  readonly display: DisplayVolume;
  readonly method: EntryMethod;
}

/**
 * `Observation.method` carries an explicit SNOMED qualifier both ways since
 * ADR-0018's amendment: `414135002` |Estimated| and `258104002` |Measured|.
 *
 * Compared against the codes `packages/core` publishes rather than testing
 * for `null`. The old `method === null ? 'measured' : 'estimated'` was
 * correct only while `null` meant measured — the moment measured entries
 * started carrying a code, that test badged **every measured entry as
 * Estimated**, silently, on the one screen a physician reads to judge
 * whether a volume was eyeballed or actually measured.
 *
 * `null` still maps to measured, because the server accepts it from a client
 * built before the amendment and rows written before the backfill could
 * carry it. Anything else unrecognised is treated as estimated: of the two
 * ways to be wrong about an unknown qualifier, over-stating uncertainty is
 * the safe direction.
 */
function toEntryMethod(method: string | null): EntryMethod {
  if (method === null) return 'measured';
  if (MEASURED_METHOD_CODE.resolved && method === MEASURED_METHOD_CODE.code) return 'measured';
  return 'estimated';
}

/**
 * Maps this patient's stoma output observations (code 79560-9, the only
 * code this release's `GET /api/v1/observations` returns) to display rows,
 * sorted chronologically (earliest first) for the timeline table — the
 * generated client itself returns most-recent-first.
 *
 * Each entry is converted using ITS OWN `enteredMeasurementSystem`
 * (ADR-0012) rather than one assumed system for the whole list, so a
 * same-system readback is never rounded (ADR-0005 AC 2.1 AC4) even on a day
 * that mixes metric and imperial entries.
 */
export function toDisplayOutputEntries(
  observations: readonly Observation[],
  targetSystem: MeasurementSystemUnits,
): readonly DisplayOutputEntry[] {
  return observations
    .flatMap((observation) => {
      const valueMl = volumeMlOf(observation);
      // An observation with no amount has no row here: this list is a
      // timeline OF VOLUMES, and there is nothing to plot or tabulate. It
      // cannot happen for the stoma output this function is called with —
      // only voided urine may omit the amount — but the type permits it, and
      // the alternative to handling it is a `!` that renders `NaN` in a
      // clinical table. Urine is shown by `UrineSignalNotice`, which is
      // built for entries that may have a colour and no number.
      if (valueMl === undefined) return [];
      return [
        {
          id: observation.id,
          effectiveDateTime: new Date(observation.effectiveDateTime),
          display: convertVolumeForDisplay(
            valueMl,
            unitsForMeasurementSystem(observation.enteredMeasurementSystem),
            targetSystem,
          ),
          method: toEntryMethod(observation.method),
        },
      ];
    })
    .sort((a, b) => a.effectiveDateTime.getTime() - b.effectiveDateTime.getTime());
}

/** `undefined` when the day's entries do not all share one entered measurement system. */
function resolveUniformEntrySystem(
  observations: readonly Observation[],
): MeasurementSystemUnits | undefined {
  const first = observations[0];
  if (!first) {
    return unitsForMeasurementSystem('metric');
  }
  const allSame = observations.every(
    (entry) => entry.enteredMeasurementSystem === first.enteredMeasurementSystem,
  );
  return allSame ? unitsForMeasurementSystem(first.enteredMeasurementSystem) : undefined;
}

/**
 * The day's total stoma output — NOT the Daily Net Fluid Balance (that
 * needs fluid intake, which is not logged yet; see `DailyBalanceNotice`).
 * Summed from canonical mL and rounded exactly once (CLAUDE.md: "Daily
 * totals are computed from canonical values and rounded once, never summed
 * from rounded per-entry display figures").
 *
 * When the day mixes entered measurement systems, there is no single
 * "same-system readback" for the total to be exempt from rounding, so it is
 * always treated as a cross-system conversion in that case — a documented
 * simplification for this minimal view rather than a general policy.
 */
export function toDisplayDailyTotal(
  observations: readonly Observation[],
  targetSystem: MeasurementSystemUnits,
): DisplayVolume {
  // Entries with no amount contribute nothing and are dropped before the sum
  // — never summed as 0. See `volumeMlOf`.
  const withVolume = observations.filter((entry) => volumeMlOf(entry) !== undefined);
  const canonicalEntries: CanonicalVolume[] = withVolume.map((entry) => ({
    value: volumeMlOf(entry) as number,
    unit: 'mL',
  }));

  // Resolved over the entries that actually contribute: a day whose only
  // volume-less entry was entered in the other system is not a mixed-system
  // day for the purpose of this total, and treating it as one would round a
  // same-system readback that ADR-0005 AC 2.1 AC4 exempts.
  const uniformEntrySystem = resolveUniformEntrySystem(withVolume);
  if (uniformEntrySystem) {
    // The ordinary case, deferred wholesale to core so ADR-0005's
    // round-once rule has exactly one implementation.
    return formatDailyVolumeTotalForDisplay(canonicalEntries, uniformEntrySystem, targetSystem);
  }

  // A day mixing entered systems. There is no single same-system readback
  // for the total to be exempt from rounding, so ADR-0005's whole-unit
  // conversion rounding applies.
  //
  // Rounded explicitly here. It used to be produced by passing
  // `convertVolumeForDisplay` the OPPOSITE of the target system — a value no
  // entry was ever recorded in, chosen only because the cross-system branch
  // happens to round. That worked, but it wrote a display decision into the
  // slot that means "what the patient entered", so anyone reading it later
  // sees a data fact where a rounding policy was intended, and any change to
  // how core decides to round would silently change this total.
  const total = formatDailyVolumeTotalForDisplay(canonicalEntries, targetSystem, targetSystem);
  return { ...total, value: Math.round(total.value) };
}

/**
 * Date/time options for every clinical timestamp this app renders.
 *
 * `timeZoneName` is the load-bearing part. `packages/core`'s `formatDateTime`
 * pins `timeZone: 'UTC'` deliberately, but `timeStyle: 'short'` emits no zone
 * — so a clinician read a UTC time as their own local time with nothing to
 * signal otherwise. On a page whose purpose is correlating output against
 * time of day, a silently-shifted clock is a clinical-reading error, not a
 * formatting nit.
 *
 * Exported and shared rather than passed ad hoc at each call site, because
 * the table and the chart's screen-reader description drifting apart is the
 * exact defect this sprint's review found.
 */
export const CLINICAL_DATE_TIME_OPTIONS: Intl.DateTimeFormatOptions = {
  // Explicit components, not `dateStyle`/`timeStyle`: `Intl.DateTimeFormat`
  // rejects those shortcuts combined with `timeZoneName` outright ("Invalid
  // option"), so the zone indicator is only reachable this way. The fields
  // below reproduce `dateStyle: 'medium'` + `timeStyle: 'short'`, which is
  // what `formatDateTime` defaults to, and the two `undefined`s clear those
  // defaults through its option spread.
  dateStyle: undefined,
  timeStyle: undefined,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
};

/**
 * The observations whose PATIENT-LOCAL day is `isoDate` (ADR-0016).
 *
 * The local day, not the UTC one. A patient in Chicago logging at 20:00 on
 * the 18th produces an instant of 01:00 UTC on the 19th, so a UTC-bounded
 * day silently files their evening under tomorrow and shows them a total
 * missing it. ADR-0016 is explicit that daily totals group by the patient's
 * local day at the moment of entry, and this is that rule applied on the
 * read side.
 *
 * Derived here rather than read off the resource: `localDate` is deliberately
 * absent from the wire (§7.2), so the client recomputes it from the same two
 * fields the server used — the instant and the zone captured at entry — with
 * `@ostomy/core`'s shared helper. Two implementations of "which day is this"
 * is exactly the disagreement ADR-0016 exists to prevent.
 *
 * An unresolvable zone (a stored value the runtime's ICU data does not know)
 * excludes the entry rather than defaulting it into the viewed day. Silently
 * filing an entry under a day it may not belong to would corrupt the very
 * figure this page exists to show; an entry missing from one day's list is
 * visible as an absence, while a wrongly-included one is not.
 */
export interface LocalDaySelection {
  /** The observations whose patient-local day is the requested one. */
  readonly onDate: readonly Observation[];
  /**
   * How many were excluded because their zone could not be resolved, and so
   * could not be assigned to any day at all.
   *
   * Counted and surfaced rather than silently dropped. Excluding them is
   * right — filing an entry under a day it may not belong to corrupts the
   * figure this page exists to show — but silence is not: if every entry of a
   * day were undatable, the page would render its "no entries were recorded"
   * empty state, which tells a physician something false about the patient
   * rather than something true about the data. The page warns instead, the
   * same way it warns about a truncated page.
   */
  readonly undatable: number;
}

export function observationsOnLocalDate(
  observations: readonly Observation[],
  isoDate: string,
): LocalDaySelection {
  const onDate: Observation[] = [];
  let undatable = 0;

  for (const observation of observations) {
    if (!isResolvableTimeZone(observation.enteredTimezone)) {
      undatable += 1;
      continue;
    }
    if (
      toLocalDate(new Date(observation.effectiveDateTime), observation.enteredTimezone) === isoDate
    ) {
      onDate.push(observation);
    }
  }

  return { onDate, undatable };
}

/**
 * Daily Net Fluid Balance for display: total intake MINUS total output
 * (SRS §3.5), converted once.
 *
 * The arithmetic is `@ostomy/core`'s, not this module's. Which side of the
 * subtraction an observation falls on is decided by its LOINC code there, so
 * voided urine is excluded even when every observation of the day is passed
 * in undifferentiated — and it must stay excluded: net balance measures
 * stoma losses while urine output independently signals renal perfusion, and
 * summing them lets a normal-looking balance hide a dangerously low urine
 * output (CLAUDE.md, SRS §3.7).
 *
 * **The result is signed, and negative is the clinically interesting case** —
 * an output-dominant day is the classic dehydration presentation. Rounding
 * uses core's half-away-from-zero, so a negative balance rounds away from
 * zero exactly as a positive one does rather than drifting toward it.
 *
 * Rounded ONCE, from canonical mL, never by summing rounded per-entry
 * figures (ADR-0005). The entry-system rule is the same as the daily
 * total's: a day entered wholly in the display system is a readback and is
 * not rounded; anything else takes the whole-unit conversion rounding.
 */
export function toDisplayNetFluidBalance(
  observations: readonly Observation[],
  targetSystem: MeasurementSystemUnits,
): DisplayVolume {
  const netMl = netDailyFluidBalanceMl(
    observations.flatMap((observation) => {
      const valueMl = volumeMlOf(observation);
      // No amount, no contribution — in either direction, and never as a
      // zero-mL reading the balance then treats as a real measurement. The
      // only observations this can be are voided urine, which the balance
      // excludes by code anyway; the guard is here so that stays true if the
      // include-set ever grows to a code that may omit its volume.
      if (valueMl === undefined) return [];
      return [{ loincCode: observation.code, valueMl }];
    }),
  );

  // Only the observations that actually contribute decide the entry system.
  // A day whose sole imperial entry is a weight would otherwise be treated as
  // mixed-system and have its balance rounded for no reason.
  const contributing = observations.filter(
    (observation) =>
      countsTowardDailyNetFluidBalance(observation.code) && volumeMlOf(observation) !== undefined,
  );
  const uniformEntrySystem = resolveUniformEntrySystem(contributing);

  return convertVolumeForDisplay(netMl, uniformEntrySystem ?? targetSystem, targetSystem);
}

/** Whether this day holds anything the balance is computed from at all. */
export function hasFluidBalanceInputs(observations: readonly Observation[]): boolean {
  return observations.some((observation) => countsTowardDailyNetFluidBalance(observation.code));
}

/**
 * Whether this observation is one of the losses the balance subtracts.
 *
 * Built on `@ostomy/core/hydration`'s named set rather than a code literal —
 * that module deliberately withholds its raw codes so it does not become a
 * second terminology entry point (ADR-0007).
 *
 * Today that set is stoma output alone, which is why the chart and table can
 * carry a "Stoma output" heading. SRS §3.5's "(and other recorded losses)"
 * is room the set is meant to grow into, and **when it does, this page's
 * headings stop being true** — the chart would silently plot two kinds of
 * event under one label. Widen the set and this predicate stays correct
 * while the copy does not; revisit both together.
 */
export function isFluidBalanceOutput(observation: Observation): boolean {
  return NET_FLUID_BALANCE_OUTPUT_LOINC_CODES.has(observation.code);
}

/** Whether this observation is one the balance adds. */
export function isFluidBalanceIntake(observation: Observation): boolean {
  return NET_FLUID_BALANCE_INTAKE_LOINC_CODES.has(observation.code);
}

/**
 * Whether this observation is the urine-output hydration signal (SRS §3.7).
 *
 * The complement of `isFluidBalanceOutput`, and deliberately not a variant of
 * it: urine is a SEPARATE signal, not a kind of output. Merging them is the
 * one thing CLAUDE.md names outright about this data — net balance measures
 * stoma losses, urine output independently signals renal perfusion, and
 * summing them lets a normal-looking balance hide a dangerously low urine
 * output.
 */
export function isUrineOutput(observation: Observation): boolean {
  return isUrineOutputSignal(observation.code);
}

/**
 * The day's voided urine, summarised for display (SRS §3.7, AC 12.1).
 *
 * Reported as a shape rather than a single number because a urine day is not
 * reducible to one: AC 12.1 AC2 makes the amount OPTIONAL, so a day can hold
 * three entries and one measured volume, and a bare "450 mL" would describe
 * that day as though the other two had not happened.
 */
export interface UrineDaySummary {
  /** Every voided-urine entry of the day, measured or not. */
  readonly entryCount: number;
  /** The measured total, or `undefined` when no entry of the day carried an amount. */
  readonly measuredTotal: DisplayVolume | undefined;
  /** How many entries contributed to that total. */
  readonly measuredCount: number;
  /**
   * The distinct colour codes recorded that day, in the order first seen.
   *
   * Codes, never labels: the words come from the i18n catalog (ADR-0006), and
   * a member an admin adds after this release ships has no copy and renders
   * through the shared "Another option" fallback rather than as a raw code.
   *
   * Deduplicated because this is a day summary, not a log — four entries all
   * recorded "Amber" is one fact about the day, and repeating it four times
   * would read as a trend where there is a single observation repeated.
   */
  readonly colorCodes: readonly string[];
}

export function toUrineDaySummary(
  observations: readonly Observation[],
  targetSystem: MeasurementSystemUnits,
): UrineDaySummary | undefined {
  const urine = observations.filter(isUrineOutput);
  if (urine.length === 0) return undefined;

  const measured = urine.filter((entry) => volumeMlOf(entry) !== undefined);

  // Same round-once rule as every other daily figure (ADR-0005): summed from
  // canonical mL and converted once, never accumulated from rounded per-entry
  // display values.
  const uniformEntrySystem = resolveUniformEntrySystem(measured);
  const measuredTotal =
    measured.length === 0
      ? undefined
      : formatDailyVolumeTotalForDisplay(
          measured.map((entry) => ({ value: volumeMlOf(entry) as number, unit: 'mL' })),
          uniformEntrySystem ?? targetSystem,
          targetSystem,
        );

  const colorCodes: string[] = [];
  for (const entry of urine) {
    const code = entry.urineColorCode;
    if (code != null && !colorCodes.includes(code)) colorCodes.push(code);
  }

  return {
    entryCount: urine.length,
    measuredTotal,
    measuredCount: measured.length,
    colorCodes,
  };
}
