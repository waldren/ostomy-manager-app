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

import type { Tier2Result, ValidationWarning } from './types.js';
import type { VolumetricValidationThresholds } from './thresholds.js';
import type { VolumetricEntryInput } from './tier1.js';

/** Tier 2 (soft, always-overridable warning) rule codes (SRS §3.8, AC 2.1 AC2). */
export const TIER2_RULE_CODE = {
  VALUE_ABOVE_TYPICAL_RANGE: 'VALUE_ABOVE_TYPICAL_RANGE',
} as const;

/**
 * SRS AC 2.1 AC2's ">2,000 mL" soft warning is an instance of this general
 * "implausible but real" class (CLAUDE.md), not a special case:
 * `softWarningMaxMl` is read from admin-managed configuration
 * (`./thresholds.js`), never hardcoded here — see
 * `no-hardcoded-thresholds.spec.ts`.
 *
 * This check is skipped only when the value is not a usable number at all
 * (Tier 1's job to flag) — never as a way of avoiding a block. A
 * `Tier2Result` cannot express a blocking outcome regardless (see
 * `./types.js` and `tier2-cannot-block.type-test.ts`), so "skip" here only
 * ever means "nothing to compare against a range," not "avoid warning."
 */
function checkValueWithinTypicalRange(
  input: VolumetricEntryInput,
  thresholds: VolumetricValidationThresholds,
): ValidationWarning | null {
  const { rawValue } = input;
  if (typeof rawValue !== 'number' || !Number.isFinite(rawValue)) return null;
  if (rawValue > thresholds.softWarningMaxMl) {
    return { field: input.field, ruleCode: TIER2_RULE_CODE.VALUE_ABOVE_TYPICAL_RANGE };
  }
  return null;
}

/**
 * Evaluate every Tier 2 rule. The return type — see `./types.js` — has no
 * outcome other than `'pass'` or `'warn'`: there is no way for this
 * function to produce a blocking result, by construction.
 */
export function evaluateTier2(
  input: VolumetricEntryInput,
  thresholds: VolumetricValidationThresholds,
): Tier2Result {
  const warnings = [checkValueWithinTypicalRange(input, thresholds)].filter(
    (warning): warning is ValidationWarning => warning !== null,
  );

  if (warnings.length === 0) {
    return { tier: 'tier2', outcome: 'pass' };
  }
  return { tier: 'tier2', outcome: 'warn', warnings };
}
