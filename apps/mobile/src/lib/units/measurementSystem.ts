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

import { unitsForMeasurementSystem } from '@ostomy/core/units';

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

/**
 * There is deliberately no default, since P4.S1 slice 3.
 *
 * `DEFAULT_MEASUREMENT_SYSTEM = 'metric'` lived here from P2.S2b until onboarding
 * existed to supply the real answer, and it was always a placeholder: ADR-0012
 * makes `entered_measurement_system` the client's assertion about what the
 * patient typed, `NOT NULL` with no default, and permanent per row — "no later
 * migration can recover the truth if it is stored wrongly". A constant that
 * satisfies that field without the patient having answered writes metric
 * provenance onto an imperial patient's entry, and nothing downstream can tell.
 *
 * It is **deleted rather than left unused** on purpose: a constant that still
 * compiles is one the next screen reaches for. Screens take the profile as a
 * required prop instead — see `src/onboarding/withProfile.tsx`.
 */
