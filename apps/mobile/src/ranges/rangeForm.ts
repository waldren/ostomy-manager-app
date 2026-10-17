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

import { ozToMl, type MeasurementSystem } from '@ostomy/core/units';
import { MAX_REPRESENTABLE_VALUE_ML, MAX_VALUE_DECIMAL_PLACES } from '@ostomy/core/validation';

import type { CachedRange } from '../db/repositories/rangesRepository';

export type RangeFormField = 'low' | 'high';

export type RangeFormErrorCode =
  /** Neither box has anything in it. A range needs at least one bound. */
  | 'needs-a-bound'
  | 'not-a-number'
  /** More decimal places than the stored value can hold (metric only; imperial is converted and rounded). */
  | 'too-precise'
  | 'outside-limits'
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
 * So a value outside them is described as one the app cannot store, never as
 * one that is unsafe.
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
  const low = readBound(input.lowText, 'low', input, errors);
  const high = readBound(input.highText, 'high', input, errors);

  if (errors.length > 0) return { status: 'invalid', errors };
  if (low === null && high === null) {
    return { status: 'invalid', errors: [{ field: 'low', code: 'needs-a-bound' }] };
  }
  if (low !== null && high !== null && Number(high) < Number(low)) {
    return { status: 'invalid', errors: [{ field: 'high', code: 'below-low' }] };
  }
  return { status: 'valid', lowValue: low, highValue: high };
}

function readBound(
  text: string,
  field: RangeFormField,
  input: { readonly measurementSystem: MeasurementSystem; readonly limits: CachedRange['limits'] },
  errors: RangeFormError[],
): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  // `Number('')` is 0 and `Number('1e3')` is 1000; the empty case is handled
  // above, and a plain-decimal pattern keeps exponent notation out.
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    errors.push({ field, code: 'not-a-number' });
    return null;
  }

  let canonical: string;
  if (input.measurementSystem === 'metric') {
    const decimals = trimmed.split('.')[1]?.length ?? 0;
    if (decimals > MAX_VALUE_DECIMAL_PLACES) {
      errors.push({ field, code: 'too-precise' });
      return null;
    }
    canonical = trimmed;
  } else {
    const factor = 10 ** MAX_VALUE_DECIMAL_PLACES;
    canonical = String(Math.round(ozToMl(Number(trimmed)) * factor) / factor);
  }

  const value = Number(canonical);
  // With no limits row the type is not one the server will accept at all, so
  // the narrowest reading applies: a positive volume the column can hold.
  const min = input.limits?.minValue ?? Number.MIN_VALUE;
  const max = input.limits?.maxValue ?? MAX_REPRESENTABLE_VALUE_ML;
  if (value < min || value > max || Math.abs(value) >= MAX_REPRESENTABLE_VALUE_ML) {
    errors.push({ field, code: 'outside-limits' });
    return null;
  }
  return canonical;
}
