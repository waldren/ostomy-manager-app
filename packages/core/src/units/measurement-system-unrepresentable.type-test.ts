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

import type { MeasurementSystemUnits } from './types.js';

/**
 * Type-level proof that a mixed-system combination cannot be constructed
 * (CLAUDE.md "Units": "Mixed-system combinations must be impossible to
 * select — make them unrepresentable in the type, not merely unselectable
 * in the UI"; ADR-0004).
 *
 * This file has no runtime assertions and is never imported by anything —
 * the proof IS the compile error suppressed below, checked by
 * `pnpm typecheck` (excluded from the built `dist/` output by
 * tsconfig.build.json, since there is nothing to run). If
 * `MeasurementSystemUnits` is ever changed to two independent fields, the
 * assignment below stops producing an error, the `@ts-expect-error`
 * directive becomes "unused", and `tsc --noEmit` fails — which is the
 * point.
 */

// @ts-expect-error — mL only pairs with kg (metric) and oz only pairs with lb (imperial); "mL" with "lb" matches neither arm of the union.
const impossible: MeasurementSystemUnits = { system: 'metric', volumeUnit: 'mL', weightUnit: 'lb' };
void impossible;

// The two legitimate pairings typecheck with no suppression needed.
const metric: MeasurementSystemUnits = { system: 'metric', volumeUnit: 'mL', weightUnit: 'kg' };
const imperial: MeasurementSystemUnits = { system: 'imperial', volumeUnit: 'oz', weightUnit: 'lb' };
void metric;
void imperial;
