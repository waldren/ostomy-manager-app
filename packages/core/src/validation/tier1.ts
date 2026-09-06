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

import type { Tier1Result, ValidationError } from './types.js';
import type { VolumetricValidationThresholds } from './thresholds.js';

/**
 * Tier 1 (hard block) rule codes for a volumetric entry (SRS §3.8, AC 2.1
 * AC1, AC 2.2 AC1). A code, never the offending value, is what a
 * `ValidationError` ever carries (docs/security-hipaa.md).
 */
export const TIER1_RULE_CODE = {
  VALUE_NOT_NUMERIC: 'VALUE_NOT_NUMERIC',
  VALUE_NOT_POSITIVE: 'VALUE_NOT_POSITIVE',
  METHOD_REQUIRED: 'METHOD_REQUIRED',
  EFFECTIVE_DATE_TIME_IN_FUTURE: 'EFFECTIVE_DATE_TIME_IN_FUTURE',
  EFFECTIVE_DATE_TIME_BEFORE_SURGERY: 'EFFECTIVE_DATE_TIME_BEFORE_SURGERY',
} as const;

export type MeasuredOrEstimated = 'measured' | 'estimated';

export interface VolumetricEntryInput {
  /** Field identifier surfaced on any resulting error/warning — never the value itself. */
  readonly field: string;
  /** The value as entered, BEFORE any "is this a number" narrowing — a patient can type anything into a form field, and an offline-queued payload is untrusted input regardless. */
  readonly rawValue: unknown;
  /** The mandatory Measured/Estimated toggle (SRS AC 2.2 AC1). `null` means "not selected yet". */
  readonly method: MeasuredOrEstimated | null;
  readonly effectiveDateTime: Date;
  /** `null` when the patient's surgery date is not yet known (onboarding-incomplete). */
  readonly surgeryDate: Date | null;
  /** Injected "current time," never read from the ambient clock, so this module stays a pure function of its inputs and is trivially testable. */
  readonly now: Date;
}

function isFiniteNumber(rawValue: unknown): rawValue is number {
  return typeof rawValue === 'number' && Number.isFinite(rawValue);
}

function checkValueIsNumeric(input: VolumetricEntryInput): ValidationError | null {
  if (!isFiniteNumber(input.rawValue)) {
    return { field: input.field, ruleCode: TIER1_RULE_CODE.VALUE_NOT_NUMERIC };
  }
  return null;
}

/**
 * Rejects zero as well as negative numbers (SRS AC 2.1 AC1: "reject
 * negative numbers, zero, and non-numeric input"). `0` here is a
 * structural invariant of what a real volume entry is, not an
 * admin-configurable threshold — a genuine zero-output event is recorded
 * as no entry, not a zero-volume observation.
 */
function checkValueIsPositive(input: VolumetricEntryInput): ValidationError | null {
  if (!isFiniteNumber(input.rawValue)) return null; // covered by checkValueIsNumeric
  if (input.rawValue <= 0) {
    return { field: input.field, ruleCode: TIER1_RULE_CODE.VALUE_NOT_POSITIVE };
  }
  return null;
}

/** SRS AC 2.2 AC1 — Mandatory Selection: saving without choosing Measured or Estimated is blocked. */
function checkMethodProvided(input: VolumetricEntryInput): ValidationError | null {
  if (input.method === null) {
    return { field: input.field, ruleCode: TIER1_RULE_CODE.METHOD_REQUIRED };
  }
  return null;
}

/** Future timestamps beyond the admin-managed clock-skew allowance are structurally impossible: they claim an event that has not happened yet. */
function checkNotInFuture(
  input: VolumetricEntryInput,
  thresholds: VolumetricValidationThresholds,
): ValidationError | null {
  const latestAllowedMs = input.now.getTime() + thresholds.maxClockSkewMs;
  if (input.effectiveDateTime.getTime() > latestAllowedMs) {
    return { field: input.field, ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_IN_FUTURE };
  }
  return null;
}

/** An entry cannot predate the patient's surgery — there was no stoma yet. */
function checkNotBeforeSurgery(input: VolumetricEntryInput): ValidationError | null {
  if (input.surgeryDate === null) return null;
  if (input.effectiveDateTime.getTime() < input.surgeryDate.getTime()) {
    return { field: input.field, ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_BEFORE_SURGERY };
  }
  return null;
}

/**
 * Evaluate every Tier 1 rule and collect every violation, not just the
 * first — a patient correcting a rejected entry benefits from seeing every
 * problem at once rather than one round trip per rule.
 */
export function evaluateTier1(
  input: VolumetricEntryInput,
  thresholds: VolumetricValidationThresholds,
): Tier1Result {
  const errors = [
    checkValueIsNumeric(input),
    checkValueIsPositive(input),
    checkMethodProvided(input),
    checkNotInFuture(input, thresholds),
    checkNotBeforeSurgery(input),
  ].filter((error): error is ValidationError => error !== null);

  if (errors.length === 0) {
    return { tier: 'tier1', outcome: 'pass' };
  }
  return { tier: 'tier1', outcome: 'blocked', errors };
}
