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

export type {
  VolumeUnit,
  WeightUnit,
  Quantity,
  CanonicalVolume,
  CanonicalWeight,
  DisplayVolume,
  DisplayWeight,
  MeasurementSystem,
  MeasurementSystemUnits,
} from './types.js';
export { unitsForMeasurementSystem } from './types.js';

export {
  mlToOz,
  ozToMl,
  kgToLb,
  lbToKg,
  convertVolumeForDisplay,
  convertWeightForDisplay,
  sumCanonicalVolumesMl,
  formatDailyVolumeTotalForDisplay,
} from './convert.js';

/** The patient's calendar day for a clinical instant (ADR-0016). Shared so the server and the offline client cannot derive it differently. */
export { isResolvableTimeZone, toLocalDate } from './localDate.js';
