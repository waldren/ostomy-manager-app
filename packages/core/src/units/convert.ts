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

import type { CanonicalVolume, DisplayVolume, DisplayWeight, MeasurementSystem } from './types.js';

/**
 * Conversion factors, defined once (ADR-0005: "they must be defined once
 * there and used by every client, not re-derived per app"). These are
 * physical unit-conversion constants — unchanging physics — not clinical
 * thresholds. `packages/core/src/validation` is where admin-managed
 * clinical bounds live, injected rather than hardcoded; this is a
 * different class of number entirely and is not subject to that rule.
 */
const ML_PER_US_FLUID_OUNCE = 29.5735295625;
const KG_PER_INTERNATIONAL_POUND = 0.45359237;

function roundToDecimalPlaces(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function mlToOz(valueMl: number): number {
  return valueMl / ML_PER_US_FLUID_OUNCE;
}

export function ozToMl(valueOz: number): number {
  return valueOz * ML_PER_US_FLUID_OUNCE;
}

export function kgToLb(valueKg: number): number {
  return valueKg / KG_PER_INTERNATIONAL_POUND;
}

export function lbToKg(valueLb: number): number {
  return valueLb * KG_PER_INTERNATIONAL_POUND;
}

/**
 * Render a canonical (mL) volume in the given measurement system
 * (SRS AC 2.1 AC4, ADR-0005).
 *
 * Displayed as entered within the same system — no rounding, the stored
 * precision is preserved. Rounded to the nearest whole unit only when the
 * display system differs from the canonical one: mL is already the
 * canonical/metric unit, so metric never rounds here; a conversion to oz
 * always does.
 */
export function convertVolumeForDisplay(
  canonicalValueMl: number,
  targetSystem: MeasurementSystem,
): DisplayVolume {
  if (targetSystem === 'metric') {
    return { value: canonicalValueMl, unit: 'mL' };
  }
  return { value: Math.round(mlToOz(canonicalValueMl)), unit: 'oz' };
}

/**
 * Render a canonical (kg) weight in the given measurement system — the
 * ADR-0005 weight carve-out from AC 2.1 AC4's whole-unit conversion
 * rounding.
 *
 * Unlike volume, weight is rounded to one decimal place in BOTH systems,
 * including metric, never to a whole unit. Rounding a converted weight to
 * a whole kilogram or pound would discard exactly the sub-kilogram
 * day-over-day change §3.12's weight signal exists to detect.
 */
export function convertWeightForDisplay(
  canonicalValueKg: number,
  targetSystem: MeasurementSystem,
): DisplayWeight {
  if (targetSystem === 'metric') {
    return { value: roundToDecimalPlaces(canonicalValueKg, 1), unit: 'kg' };
  }
  return { value: roundToDecimalPlaces(kgToLb(canonicalValueKg), 1), unit: 'lb' };
}

/**
 * Sum canonical volumes with no rounding at any point — the exact
 * canonical total. Rounding, if any, is applied once, downstream, by
 * `formatDailyVolumeTotalForDisplay` or a caller's own display step.
 */
export function sumCanonicalVolumesMl(entries: readonly CanonicalVolume[]): number {
  return entries.reduce((total, entry) => total + entry.value, 0);
}

/**
 * Compute a daily volume total from canonical values and round it exactly
 * once, at the end (CLAUDE.md: "Daily totals are computed from canonical
 * values and rounded once, never summed from rounded per-entry display
 * figures"). Summing per-entry DISPLAY figures — each already rounded to a
 * whole oz — can disagree with the true total by more than rounding error
 * alone; see convert.spec.ts for a worked counterexample.
 */
export function formatDailyVolumeTotalForDisplay(
  entries: readonly CanonicalVolume[],
  targetSystem: MeasurementSystem,
): DisplayVolume {
  return convertVolumeForDisplay(sumCanonicalVolumesMl(entries), targetSystem);
}
