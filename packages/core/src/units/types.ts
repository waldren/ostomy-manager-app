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
 * Canonical storage units (ADR-0004): every volume is stored in millilitres
 * and every weight in kilograms, regardless of the patient's measurement
 * system preference. Imperial is a render-time conversion only, applied by
 * `convertVolumeForDisplay` / `convertWeightForDisplay` in `./convert.js`.
 * Stored (canonical) values are never rounded and never rewritten
 * (ADR-0005).
 */

export type VolumeUnit = 'mL' | 'oz';
export type WeightUnit = 'kg' | 'lb';

/**
 * A quantity paired with its unit. `TUnit` is the discriminant, so
 * `Quantity<'mL'>` and `Quantity<'oz'>` are different, non-interchangeable
 * types.
 */
export interface Quantity<TUnit extends string> {
  readonly value: number;
  readonly unit: TUnit;
}

/** A volume in the canonical storage unit (ADR-0004). Never rounded. */
export type CanonicalVolume = Quantity<'mL'>;

/** A weight in the canonical storage unit (ADR-0004). Never rounded. */
export type CanonicalWeight = Quantity<'kg'>;

/** A volume as rendered to a patient or clinician, in whichever unit their measurement system implies. */
export type DisplayVolume = Quantity<VolumeUnit>;

/** A weight as rendered to a patient or clinician. */
export type DisplayWeight = Quantity<WeightUnit>;

/**
 * The single metric/imperial preference that governs both volume and
 * weight (SRS_v2 §3.10, CLAUDE.md "Units"). Modelled as one discriminated
 * union — not two independent `volumeUnit` / `weightUnit` fields — so that
 * a mixed-system combination (millilitres paired with pounds, ounces
 * paired with kilograms) cannot be constructed: a literal like
 * `{ system: 'metric', volumeUnit: 'mL', weightUnit: 'lb' }` does not
 * structurally match either arm of this union and fails to typecheck. See
 * `measurement-system-unrepresentable.type-test.ts` for the compile-time
 * proof. This is "unrepresentable in the type," not merely something the
 * UI happens not to offer.
 */
export type MeasurementSystemUnits =
  | { readonly system: 'metric'; readonly volumeUnit: 'mL'; readonly weightUnit: 'kg' }
  | { readonly system: 'imperial'; readonly volumeUnit: 'oz'; readonly weightUnit: 'lb' };

export type MeasurementSystem = MeasurementSystemUnits['system'];

/**
 * The only supported way to obtain a `MeasurementSystemUnits` value, so
 * every consumer goes through this pairing rather than assembling a
 * volume unit and a weight unit as two separate, independently-settable
 * fields.
 */
export function unitsForMeasurementSystem(system: MeasurementSystem): MeasurementSystemUnits {
  switch (system) {
    case 'metric':
      return { system: 'metric', volumeUnit: 'mL', weightUnit: 'kg' };
    case 'imperial':
      return { system: 'imperial', volumeUnit: 'oz', weightUnit: 'lb' };
  }
}
