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

import type { Tier2Result } from './types.js';

/**
 * Type-level proof that a Tier 2 (soft) result cannot express a blocking
 * outcome (CLAUDE.md "Validation": "A warning must never become a block");
 * the return TYPE distinguishes Tier 1 from Tier 2, not a severity field
 * someone could compare wrongly.
 *
 * This file has no runtime assertions and is never imported by anything —
 * the proof IS the compile error suppressed below, checked by
 * `pnpm typecheck` (excluded from the built `dist/` output by
 * tsconfig.build.json, since there is nothing to run). If `Tier2Result`'s
 * outcome union is ever widened to include `'blocked'`, the assignment
 * below stops producing an error, the `@ts-expect-error` directive becomes
 * "unused", and `tsc --noEmit` fails — which is the point.
 */

type Tier2Outcomes = Tier2Result['outcome'];

// @ts-expect-error — 'blocked' is not a member of Tier2Result['outcome']; only 'pass' and 'warn' are.
const impossible: Tier2Outcomes = 'blocked';
void impossible;

// The two legitimate outcomes typecheck with no suppression needed.
const pass: Tier2Outcomes = 'pass';
const warn: Tier2Outcomes = 'warn';
void pass;
void warn;
