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
 * Two-tier validation result types (SRS §3.8, CLAUDE.md "Validation").
 *
 * `field` and `ruleCode` are the only data either result type carries.
 * docs/security-hipaa.md is explicit: "Validation errors return field
 * identifiers and rule codes, never the offending value." There is no
 * field here in which a clinical value could accidentally be serialized —
 * that is enforced by this type's shape, not by a convention every call
 * site has to remember.
 */

export type FieldId = string;
export type RuleCode = string;

export interface ValidationError {
  readonly field: FieldId;
  readonly ruleCode: RuleCode;
}

export interface ValidationWarning {
  readonly field: FieldId;
  readonly ruleCode: RuleCode;
}

export type Tier1Outcome = 'pass' | 'blocked';
export type Tier2Outcome = 'pass' | 'warn';

/**
 * Tier 1 (hard block) result. Structurally, this type expresses exactly
 * two states — pass, or blocked-with-errors — never a severity someone
 * could compare wrongly.
 */
export type Tier1Result =
  | { readonly tier: 'tier1'; readonly outcome: 'pass' }
  | {
      readonly tier: 'tier1';
      readonly outcome: 'blocked';
      readonly errors: readonly ValidationError[];
    };

/**
 * Tier 2 (soft, always-overridable warning) result. This is the type that
 * makes "a soft warning must be structurally incapable of blocking"
 * (CLAUDE.md) true at compile time rather than by convention:
 * `Tier2Outcome` has exactly two members, `'pass'` and `'warn'`, and
 * neither is `'blocked'`. There is no code path in this codebase by which
 * a `Tier2Result` can carry a blocking outcome, because the type does not
 * have one to assign. See `tier2-cannot-block.type-test.ts` for the
 * compile-time proof: a file typechecked by `pnpm typecheck` that fails
 * the build if this invariant is ever weakened.
 */
export type Tier2Result =
  | { readonly tier: 'tier2'; readonly outcome: 'pass' }
  | {
      readonly tier: 'tier2';
      readonly outcome: 'warn';
      readonly warnings: readonly ValidationWarning[];
    };

export interface VolumetricValidationResult {
  readonly tier1: Tier1Result;
  readonly tier2: Tier2Result;
}

/** Whether the entry may be saved as-is. Depends only on Tier 1 — Tier 2 never blocks, by construction. */
export function isBlocked(result: VolumetricValidationResult): boolean {
  return result.tier1.outcome === 'blocked';
}

export function hasWarnings(result: VolumetricValidationResult): boolean {
  return result.tier2.outcome === 'warn';
}
