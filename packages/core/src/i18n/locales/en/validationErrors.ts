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
 * Tier 1 (hard block) copy — SRS §3.8. Deliberately its own namespace,
 * separate from `validationWarnings` and `redFlags`, per ADR-0006: a
 * reviewer auditing tone must be able to tell "this stops the save" apart
 * from "this saves normally and asks for confirmation" apart from "seek
 * care" from the catalog's structure alone.
 *
 * Keyed by the same rule codes `packages/core/src/validation` returns on
 * `ValidationError.ruleCode` — see `../../catalog.spec.ts`, which asserts
 * this object's keys match `TIER1_RULE_CODE` exactly, so a rule code with
 * no catalog entry is a test failure here rather than a missing-key
 * fallback rendered in front of a patient.
 */
export const validationErrors = {
  VALUE_NOT_NUMERIC: 'Enter the amount as a number.',
  // S8 (this sprint's review): simplified from "Enter an amount greater
  // than zero" to a plainer positive instruction at the target 6th-8th
  // grade reading level.
  VALUE_NOT_POSITIVE: 'Enter an amount above 0.',
  // S8: the previous copy ("Choose whether this amount was measured or
  // estimated") tested at roughly a 9.7 grade level (passive, formal
  // "whether"). Rewritten as a direct, active instruction.
  // P2.S1a: both of these replace what used to be a server error the
  // patient could not act on. Kept short and concrete — the patient's
  // realistic route here is a typo (an extra digit, or a pasted value),
  // so the copy says what to do rather than naming a storage limit.
  VALUE_EXCEEDS_MAX_MAGNITUDE: 'Enter a smaller amount.',
  VALUE_EXCEEDS_MAX_PRECISION: 'Use no more than 4 numbers after the decimal point.',
  METHOD_REQUIRED: 'Tell us if you measured this amount or estimated it.',
  METHOD_NOT_APPLICABLE: 'This entry has no amount, so there is nothing to measure or estimate.',
  // S8: simplified from "Choose a date and time that has already happened."
  EFFECTIVE_DATE_TIME_IN_FUTURE: 'Choose a date and time in the past.',
  EFFECTIVE_DATE_TIME_BEFORE_SURGERY: 'Choose a date on or after your surgery date.',
} as const;
