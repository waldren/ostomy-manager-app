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

import { mlToOz, ozToMl, type MeasurementSystem } from '@ostomy/core/units';
import { MAX_REPRESENTABLE_VALUE_ML, MAX_VALUE_DECIMAL_PLACES } from '@ostomy/core/validation';

import type { CachedRange } from '../db/repositories/rangesRepository';

export type RangeFormField = 'low' | 'high';

export type RangeFormErrorCode =
  /** Neither box has anything in it. A range needs at least one bound. */
  | 'needs-a-bound'
  | 'not-a-number'
  /** More decimal places than the stored value can hold (metric only; imperial is converted and rounded). */
  | 'too-precise'
  /** Zero or below, for a type whose values are positive. */
  | 'not-positive'
  /** Below the type's lowest storable value. */
  | 'too-small'
  /** Above the type's highest storable value. */
  | 'too-big'
  /** The upper bound is below the lower one. */
  | 'below-low';

export interface RangeFormError {
  readonly field: RangeFormField;
  readonly code: RangeFormErrorCode;
}

export type RangeFormResult =
  | {
      readonly status: 'valid';
      /** Canonical millilitres, as exact decimal strings (local migration 1's rule). */
      readonly lowValue: string | null;
      readonly highValue: string | null;
    }
  | { readonly status: 'invalid'; readonly errors: readonly RangeFormError[] };

/** Every limit a bound is held to, in canonical millilitres. */
export interface RangeFormLimits {
  readonly minValue: number;
  readonly maxValue: number;
}

/**
 * What a bound may be: the type's limits, or, with no limits row, the
 * narrowest reading (a positive volume the column can hold). A type with no
 * limits row is not one the server accepts at all, so that case only has to be
 * safe, not useful.
 */
export function effectiveLimits(limits: CachedRange['limits']): RangeFormLimits {
  return {
    minValue: limits?.minValue ?? Number.MIN_VALUE,
    maxValue: Math.min(limits?.maxValue ?? MAX_REPRESENTABLE_VALUE_ML, MAX_REPRESENTABLE_VALUE_ML),
  };
}

/**
 * Reads the "set my own range" form (P4.S3 slice 4) into canonical values.
 *
 * The server re-checks every one of these (`docs/sync-contract.md` §7.6), so
 * this is the UX half: a value refused here is fixed with the form in front of
 * the patient, while the same value refused on push lands in the correction
 * inbox, which is a worse place to learn it.
 *
 * ## The limits are structural, and so are these messages
 *
 * `limits` comes from `clinical_default_range_limits`, whose numbers are
 * "a volume is positive" and the column's own ceiling — not clinical advice.
 * So a value outside them is described as one the app cannot store, and the
 * error says what it CAN store (WCAG 3.3.3), never that a value is unsafe.
 *
 * ## Units
 *
 * The patient types in their own system. Metric is stored as typed, like an
 * entry; imperial is converted and rounded to the canonical column's scale,
 * the same step `toCanonicalValueString` takes, or the server's precision rule
 * refuses every imperial value with a complaint about decimals nobody typed.
 */
export function readRangeForm(input: {
  readonly lowText: string;
  readonly highText: string;
  readonly measurementSystem: MeasurementSystem;
  readonly limits: CachedRange['limits'];
}): RangeFormResult {
  const errors: RangeFormError[] = [];
  const limits = effectiveLimits(input.limits);
  const low = readBound(input.lowText, 'low', input.measurementSystem, limits, errors);
  const high = readBound(input.highText, 'high', input.measurementSystem, limits, errors);

  if (errors.length > 0) return { status: 'invalid', errors };
  if (low === null && high === null) {
    return { status: 'invalid', errors: [{ field: 'low', code: 'needs-a-bound' }] };
  }
  if (low !== null && high !== null && Number(high) < Number(low)) {
    return { status: 'invalid', errors: [{ field: 'high', code: 'below-low' }] };
  }
  return { status: 'valid', lowValue: low, highValue: high };
}

/**
 * The text as a plain decimal, or `undefined`.
 *
 * Forgiving where a patient is likely to type something reasonable: a
 * typographic minus or dash (which some keyboards substitute), and thousands
 * separators ("1,500"). Strict everywhere else: `Number('1e3')` is 1000 and
 * `Number('')` is 0, and neither is a number the patient typed.
 */
function normalise(text: string): string | undefined {
  const trimmed = text.trim().replace(/^[−–—]/, '-');
  const withoutGrouping = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(trimmed)
    ? trimmed.replace(/,/g, '')
    : trimmed;
  return /^-?\d+(\.\d+)?$/.test(withoutGrouping) ? withoutGrouping : undefined;
}

function readBound(
  text: string,
  field: RangeFormField,
  system: MeasurementSystem,
  limits: RangeFormLimits,
  errors: RangeFormError[],
): string | null {
  if (text.trim() === '') return null;

  const plain = normalise(text);
  if (plain === undefined) {
    errors.push({ field, code: 'not-a-number' });
    return null;
  }

  let canonical: string;
  if (system === 'metric') {
    const decimals = plain.split('.')[1]?.length ?? 0;
    if (decimals > MAX_VALUE_DECIMAL_PLACES) {
      errors.push({ field, code: 'too-precise' });
      return null;
    }
    canonical = plain;
  } else {
    canonical = String(toColumnScale(ozToMl(Number(plain))));
  }

  const value = Number(canonical);
  if (value < limits.minValue) {
    // A floor below one millilitre is the structural "a volume is positive"
    // rule, and "bigger than 0" is the plain way to say it.
    const positiveOnly = limits.minValue > 0 && limits.minValue < 1;
    errors.push({ field, code: positiveOnly ? 'not-positive' : 'too-small' });
    return null;
  }
  if (value > limits.maxValue) {
    errors.push({ field, code: 'too-big' });
    return null;
  }
  return canonical;
}

function toColumnScale(value: number): number {
  const factor = 10 ** MAX_VALUE_DECIMAL_PLACES;
  return Math.round(value * factor) / factor;
}

/**
 * A stored canonical value as text the patient can read and save again, for
 * pre-filling the form with their current range.
 *
 * Rounded to the column's scale, not to ADR-0005's whole display unit: this
 * value may be saved back, and display rounding travelling inward would change
 * a range the patient only meant to adjust on one side. `corrections.tsx`'s
 * `editableAmountIn` does the same for an entry.
 */
export function toEditableText(canonicalMl: number | null, system: MeasurementSystem): string {
  if (canonicalMl === null) return '';
  return String(toColumnScale(system === 'imperial' ? mlToOz(canonicalMl) : canonicalMl));
}
