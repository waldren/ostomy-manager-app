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
  sumCanonicalVolumesMl,
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
  const totalMl = sumCanonicalVolumesMl(canonicalEntries);

  const uniformEntrySystem = resolveUniformEntrySystem(observations);
  const entrySystemForRounding =
    uniformEntrySystem ??
    unitsForMeasurementSystem(targetSystem.system === 'metric' ? 'imperial' : 'metric');

  return convertVolumeForDisplay(totalMl, entrySystemForRounding, targetSystem);
}
