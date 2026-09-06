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
 * Threshold-injection interface (SRS §3.11; CLAUDE.md "Validation":
 * "Numeric thresholds are admin-managed configuration, not constants in
 * code"). This file names the SHAPE of a threshold set. It never assigns
 * one a value — that would defeat the point.
 *
 * Any caller satisfies this with a plain object: the API reading
 * `validation_thresholds` rows from Postgres (P1.S5's `ThresholdsService`,
 * not built yet), a mobile client caching the same values for offline
 * validation, or a test fixture. Nothing in `packages/core/src/validation`
 * reads a threshold from anywhere but a value of this shape passed in as
 * an argument — see `validation/no-hardcoded-thresholds.spec.ts`, which
 * statically checks the rule-evaluation modules for a stray numeric
 * literal that should have come from here instead.
 */
export interface VolumetricValidationThresholds {
  /**
   * Soft-warning ceiling for a single volumetric entry, in canonical mL.
   * SRS AC 2.1 AC2's ">2,000 mL" rule is ONE admin-configured value of
   * this threshold, not a special case with its own code path.
   */
  readonly softWarningMaxMl: number;

  /**
   * Maximum allowed clock skew, in milliseconds, before an entry's
   * `effectiveDateTime` in the future is hard-blocked rather than
   * accepted.
   */
  readonly maxClockSkewMs: number;
}
