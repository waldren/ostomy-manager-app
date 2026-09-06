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

import type { VolumetricValidationResult } from './types.js';
import type { VolumetricValidationThresholds } from './thresholds.js';
import { evaluateTier1, type VolumetricEntryInput } from './tier1.js';
import { evaluateTier2 } from './tier2.js';

export type { VolumetricEntryInput, MeasuredOrEstimated } from './tier1.js';

/**
 * Validate a single volumetric entry (stoma output, fluid intake, voided
 * urine — any field carrying the mandatory Measured/Estimated toggle, SRS
 * §3.8) against both tiers.
 *
 * Both tiers are evaluated independently and unconditionally — a Tier 1
 * block never suppresses Tier 2 evaluation, and Tier 2 never influences
 * Tier 1's outcome — because the two tiers answer different questions ("is
 * this structurally possible" vs. "is this plausible") and CLAUDE.md
 * requires each defined once, here, and composed the same way by every
 * caller. Tier 2's magnitude check naturally has nothing to compare when
 * there is no usable number (see `./tier2.js`).
 */
export function validateVolumetricEntry(
  input: VolumetricEntryInput,
  thresholds: VolumetricValidationThresholds,
): VolumetricValidationResult {
  return {
    tier1: evaluateTier1(input, thresholds),
    tier2: evaluateTier2(input, thresholds),
  };
}
