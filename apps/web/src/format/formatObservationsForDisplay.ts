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
  unitsForMeasurementSystem,
  type CanonicalVolume,
  type DisplayVolume,
  type MeasurementSystemUnits,
} from '@ostomy/core/units';
import type { Observation } from '@ostomy/core/api-client';

export type EntryMethod = 'measured' | 'estimated';

export interface DisplayOutputEntry {
  readonly id: string;
  readonly effectiveDateTime: Date;
  readonly display: DisplayVolume;
  readonly method: EntryMethod;
}

/** `Observation.method` carries a SNOMED CT estimation-technique code when estimated, and is `null` when measured (CLAUDE.md). */
function toEntryMethod(method: string | null): EntryMethod {
  return method === null ? 'measured' : 'estimated';
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
    .map((observation) => ({
      id: observation.id,
      effectiveDateTime: new Date(observation.effectiveDateTime),
      display: convertVolumeForDisplay(
        observation.valueQuantity.value,
        unitsForMeasurementSystem(observation.enteredMeasurementSystem),
        targetSystem,
      ),
      method: toEntryMethod(observation.method),
    }))
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
  const canonicalEntries: CanonicalVolume[] = observations.map((entry) => ({
    value: entry.valueQuantity.value,
    unit: 'mL',
  }));

  const uniformEntrySystem = resolveUniformEntrySystem(observations);
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
