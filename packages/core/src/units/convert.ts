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

import type {
  CanonicalVolume,
  DisplayVolume,
  DisplayWeight,
  MeasurementSystemUnits,
} from './types.js';

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

/**
 * Round-half-away-from-zero, by magnitude with the sign reapplied
 * afterward, and with `-0` normalised to `0` (S3, this sprint's review).
 *
 * `Math.round` rounds half toward +Infinity: `Math.round(-2.5) === -2`, a
 * bias that — once Daily Net Fluid Balance is negative, which is the
 * routine case for an output-dominant day (SRS §3.5) — would round a
 * negative total TOWARD zero, i.e. toward looking less dehydrated. That is
 * the wrong direction for a safety-relevant number, so rounding here is
 * done on the magnitude and the original sign is reapplied, never on the
 * signed value directly.
 *
 * `-0` is normalised to `0` because `Math.round(-0.4)` is `-0`, and
 * `Intl.NumberFormat` renders that as the literal string "-0" — a patient
 * would see e.g. "-0 oz" for an amount that, for display purposes, is
 * zero.
 */
function roundHalfAwayFromZero(value: number): number {
  const rounded = Math.sign(value) * Math.round(Math.abs(value));
  return rounded === 0 ? 0 : rounded;
}

function roundToDecimalPlaces(value: number, places: number): number {
  const factor = 10 ** places;
  return roundHalfAwayFromZero(value * factor) / factor;
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
 * Render a canonical (mL) volume in a target measurement system
 * (SRS AC 2.1 AC4, ADR-0005).
 *
 * `entrySystem` is REQUIRED, not optional-with-a-default — ADR-0005 states
 * the whole-unit rounding rule in terms of the system the value was
 * ENTERED in, not the canonical storage unit. The schema (P1.S3) stores
 * only canonical mL/kg plus the patient's current `Profile.measurementSystem`
 * preference, which §3.10 lets change, so "canonical unit" and "entry
 * unit" are not the same fact and this function must not conflate them: a
 * value entered in mL and later viewed in mL (same system, no conversion
 * needed) must read back at its entered precision — rounding it to a
 * whole unit is exactly the "8.5 oz reads back as 9 oz" defect this
 * parameter exists to prevent. Rounding to a whole unit applies only when
 * `targetSystem` differs from `entrySystem` — a genuine cross-system
 * conversion (AC 2.1 AC4: "a stored volume is displayed in a measurement
 * system other than the one in which it was entered") — never on a
 * same-system readback.
 *
 * An optional parameter with a default is how this rule silently reverts;
 * making it required means a future caller that hasn't resolved the entry
 * system (once the `entered_measurement_system` schema column exists) gets
 * a compile error instead of a silently wrong render.
 */
export function convertVolumeForDisplay(
  canonicalValueMl: number,
  entrySystem: MeasurementSystemUnits,
  targetSystem: MeasurementSystemUnits,
): DisplayVolume {
  const isCrossSystemConversion = entrySystem.system !== targetSystem.system;

  if (targetSystem.system === 'metric') {
    return {
      value: isCrossSystemConversion ? roundHalfAwayFromZero(canonicalValueMl) : canonicalValueMl,
      unit: 'mL',
    };
  }

  const valueOz = mlToOz(canonicalValueMl);
  return {
    value: isCrossSystemConversion ? roundHalfAwayFromZero(valueOz) : valueOz,
    unit: 'oz',
  };
}

/**
 * Render a canonical (kg) weight in the given measurement system — the
 * ADR-0005 weight carve-out from AC 2.1 AC4's whole-unit conversion
 * rounding.
 *
 * Unlike volume, weight is rounded to one decimal place in BOTH systems,
 * including metric, never to a whole unit, and regardless of whether this
 * is a same-system readback or a cross-system conversion. Rounding a
 * converted weight to a whole kilogram or pound would discard exactly the
 * sub-kilogram day-over-day change §3.12's weight signal exists to detect
 * — so unlike volume, there is no entry-system-dependent branch here; this
 * function takes only the target system, typed as `MeasurementSystemUnits`
 * (not a bare `MeasurementSystem` string) so it cannot be paired with a
 * different, mismatched units object than a sibling `convertVolumeForDisplay`
 * call for the same screen (S1, this sprint's review).
 */
export function convertWeightForDisplay(
  canonicalValueKg: number,
  targetSystem: MeasurementSystemUnits,
): DisplayWeight {
  if (targetSystem.system === 'metric') {
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
  entrySystem: MeasurementSystemUnits,
  targetSystem: MeasurementSystemUnits,
): DisplayVolume {
  return convertVolumeForDisplay(sumCanonicalVolumesMl(entries), entrySystem, targetSystem);
}
