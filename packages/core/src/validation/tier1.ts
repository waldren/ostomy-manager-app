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
import { exceedsMaxMagnitude, exceedsMaxPrecision } from './representableRange.js';

/**
 * Tier 1 (hard block) rule codes for a volumetric entry (SRS §3.8, AC 2.1
 * AC1, AC 2.2 AC1). A code, never the offending value, is what a
 * `ValidationError` ever carries (docs/security-hipaa.md).
 */
export const TIER1_RULE_CODE = {
  VALUE_NOT_NUMERIC: 'VALUE_NOT_NUMERIC',
  VALUE_NOT_POSITIVE: 'VALUE_NOT_POSITIVE',
  VALUE_EXCEEDS_MAX_MAGNITUDE: 'VALUE_EXCEEDS_MAX_MAGNITUDE',
  VALUE_EXCEEDS_MAX_PRECISION: 'VALUE_EXCEEDS_MAX_PRECISION',
  METHOD_REQUIRED: 'METHOD_REQUIRED',
  EFFECTIVE_DATE_TIME_IN_FUTURE: 'EFFECTIVE_DATE_TIME_IN_FUTURE',
  EFFECTIVE_DATE_TIME_BEFORE_SURGERY: 'EFFECTIVE_DATE_TIME_BEFORE_SURGERY',
} as const;

export type MeasuredOrEstimated = 'measured' | 'estimated';

export interface VolumetricEntryInput {
  /** Field identifier surfaced on any resulting error/warning — never the value itself. */
  readonly field: string;
  /**
   * The value BEFORE any "is this a number" narrowing — a patient can type
   * anything into a form field, and an offline-queued payload is untrusted
   * input regardless. Named `rawValueMl`, not `rawValue`: despite the
   * "raw" in the name, this is NOT the value as the patient typed it in
   * their preferred unit — the caller MUST convert to canonical millilitres
   * (ADR-0004) before constructing this input. `softWarningMaxMl` (B3, this
   * sprint's review) and every other threshold this module compares against
   * are canonical-mL bounds; comparing an un-converted imperial entry (e.g.
   * `80` for 80 oz) against a canonical-mL threshold silently never fires
   * for imperial patients. ADR-0004 makes "callers convert before
   * validating" the only coherent reading of this field.
   */
  readonly rawValueMl: unknown;
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
  if (!isFiniteNumber(input.rawValueMl)) {
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
  if (!isFiniteNumber(input.rawValueMl)) return null; // covered by checkValueIsNumeric
  if (input.rawValueMl <= 0) {
    return { field: input.field, ruleCode: TIER1_RULE_CODE.VALUE_NOT_POSITIVE };
  }
  return null;
}

/**
 * A value the canonical column cannot hold is structurally impossible input,
 * in the same sense as a negative volume — see `representableRange.ts` for
 * why these two rules exist at Tier 1 rather than as a database error, and
 * why their bounds are literals there rather than injected thresholds.
 */
function checkValueIsRepresentable(input: VolumetricEntryInput): ValidationError | null {
  if (!isFiniteNumber(input.rawValueMl)) return null; // covered by checkValueIsNumeric
  if (exceedsMaxMagnitude(input.rawValueMl)) {
    return { field: input.field, ruleCode: TIER1_RULE_CODE.VALUE_EXCEEDS_MAX_MAGNITUDE };
  }
  return null;
}

/**
 * Rejects a value carrying more fractional digits than the column preserves.
 * Postgres would otherwise round it silently and store something the patient
 * did not enter, breaking ADR-0005's "stored values keep their entered
 * precision" with no error on either side.
 */
function checkValuePrecision(input: VolumetricEntryInput): ValidationError | null {
  if (!isFiniteNumber(input.rawValueMl)) return null; // covered by checkValueIsNumeric
  if (exceedsMaxPrecision(input.rawValueMl)) {
    return { field: input.field, ruleCode: TIER1_RULE_CODE.VALUE_EXCEEDS_MAX_PRECISION };
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
    checkValueIsRepresentable(input),
    checkValuePrecision(input),
    checkMethodProvided(input),
    checkNotInFuture(input, thresholds),
    checkNotBeforeSurgery(input),
  ].filter((error): error is ValidationError => error !== null);

  if (errors.length === 0) {
    return { tier: 'tier1', outcome: 'pass' };
  }
  return { tier: 'tier1', outcome: 'blocked', errors };
}
