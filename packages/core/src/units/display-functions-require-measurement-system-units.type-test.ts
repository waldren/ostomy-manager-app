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
  convertWeightForDisplay,
  unitsForMeasurementSystem,
} from './index.js';

/**
 * Compile-time proof for S1 (this sprint's review). Before this change,
 * `convertVolumeForDisplay` and `convertWeightForDisplay` each took a bare
 * `MeasurementSystem` ('metric' | 'imperial') independently, so this
 * compiled with no cast at all — `MeasurementSystemUnits` was a guarded
 * type no function actually accepted or returned:
 *
 *   const mixed = {
 *     volume: convertVolumeForDisplay(1000, 'metric', 'metric'),
 *     weight: convertWeightForDisplay(70, 'imperial'),
 *   };
 *
 * Now that both display functions require `MeasurementSystemUnits`
 * (obtained only via `unitsForMeasurementSystem`, per its own doc
 * comment), passing a bare string literal is a compile error rather than
 * a silently-accepted mismatched system.
 *
 * This file has no runtime assertions and is never imported by anything —
 * the proof IS the compile error suppressed below, checked by
 * `pnpm typecheck` (excluded from the built `dist/` output by
 * tsconfig.build.json, since there is nothing to run).
 */

const metric = unitsForMeasurementSystem('metric');

// @ts-expect-error — 'metric' is a bare string, not a `MeasurementSystemUnits` object; convertVolumeForDisplay no longer accepts it.
const impossibleVolume = convertVolumeForDisplay(1000, 'metric', 'metric');
void impossibleVolume;

// @ts-expect-error — same reason, for the target-system parameter specifically.
const impossibleVolumeTarget = convertVolumeForDisplay(1000, metric, 'imperial');
void impossibleVolumeTarget;

// @ts-expect-error — 'imperial' is a bare string, not a `MeasurementSystemUnits` object; convertWeightForDisplay no longer accepts it.
const impossibleWeight = convertWeightForDisplay(70, 'imperial');
void impossibleWeight;

// The legitimate call shape typechecks with no suppression needed: both
// display functions consuming `MeasurementSystemUnits` obtained from the
// same, single source.
const legitimate = {
  volume: convertVolumeForDisplay(1000, metric, metric),
  weight: convertWeightForDisplay(70, metric),
};
void legitimate;
