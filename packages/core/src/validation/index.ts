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
  FieldId,
  RuleCode,
  ValidationError,
  ValidationWarning,
  Tier1Outcome,
  Tier2Outcome,
  Tier1Result,
  Tier2Result,
  VolumetricValidationResult,
} from './types.js';
export { isBlocked, hasWarnings } from './types.js';

export type { VolumetricValidationThresholds } from './thresholds.js';

export { TIER1_RULE_CODE } from './tier1.js';
export { evaluateTier1 } from './tier1.js';

export { TIER2_RULE_CODE } from './tier2.js';

/**
 * The timestamp half of Tier 1, usable by an entry type that has no value —
 * a meal (SRS AC 2.4). Composed by `evaluateTier1` too, so a volumetric entry
 * and a meal cannot disagree about what "in the future" means.
 */
export {
  checkEntryNotBeforeSurgery,
  checkEntryNotInFuture,
  evaluateEntryTimestamp,
  type EntryTimestampInput,
} from './entryTimestamp.js';
export { evaluateTier2 } from './tier2.js';

export {
  validateVolumetricEntry,
  type VolumetricEntryInput,
  type MeasuredOrEstimated,
} from './volumetric.js';

export {
  ESTIMATION_METHOD_CODE,
  MEASURED_METHOD_CODE,
  type EstimationMethodCode,
} from './estimationMethod.js';

/**
 * The canonical column's representability bounds.
 *
 * Exported because a CLIENT converting an imperial entry needs the scale:
 * the conversion, not the patient, is what produces more fractional digits
 * than `DECIMAL(12,4)` can hold, and a client that does not round to this
 * scale has Tier 1 block every imperial entry with a message about decimal
 * places the patient never typed. See `./representableRange.js` for why
 * these are structural facts rather than injectable thresholds.
 */
export { validateVolumelessObservation } from './volumeless.js';
export type { VolumelessObservationInput } from './volumeless.js';

export { MAX_REPRESENTABLE_VALUE_ML, MAX_VALUE_DECIMAL_PLACES } from './representableRange.js';
