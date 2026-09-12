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

import { unitsForMeasurementSystem, type MeasurementSystem } from '@ostomy/core/units';

/**
 * Re-exports the single-preference type from `@ostomy/core/units` under
 * this app's own module path, so screens import from one local place
 * rather than reaching into the shared package everywhere — and so a
 * future `apps/mobile`-local concept (e.g. a persisted "last chosen unit
 * for this screen" affordance) has somewhere to live beside it without
 * being mistaken for shared logic.
 *
 * CLAUDE.md "Units": a single metric/imperial preference governs both
 * volume and weight, unrepresentable any other way in the type
 * (`MeasurementSystemUnits` is a discriminated union, not two independent
 * fields) — this module never introduces a second axis.
 */
export type { MeasurementSystem, MeasurementSystemUnits } from '@ostomy/core/units';
export { unitsForMeasurementSystem };

export const DEFAULT_MEASUREMENT_SYSTEM: MeasurementSystem = 'metric';
