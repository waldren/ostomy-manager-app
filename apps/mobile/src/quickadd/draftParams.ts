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

import { convertVolumeForDisplay, unitsForMeasurementSystem } from '@ostomy/core/units';
import type { MeasurementSystem } from '@ostomy/core/units';
import type { MeasuredOrEstimated } from '@ostomy/core/validation';

import {
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
} from '../entry/observationCodes';

import type { QuickAddSuggestion } from './quickAddSuggestions';

/**
 * "Open as a pre-filled template" (Epic 3's second Quick-Add story), carried
 * to the entry screen as route params.
 *
 * ## Why the route rather than shared state
 *
 * Expo Router already owns navigation here, and a param is readable, loggable
 * and testable as a plain value. A context or a module-level draft would be
 * state two screens have to agree about keeping in step, for a handoff that
 * happens once and is read once.
 *
 * ## The amount crosses as a DISPLAY value, not a canonical one
 *
 * The entry screens' `amountText` is what the patient typed, in their own
 * units, and `toCanonicalValueString` converts on save. So a prefill has to
 * arrive in the same shape, or an imperial patient would meet "350" in a field
 * labelled oz and save 10,352 mL.
 *
 * `convertVolumeForDisplay` is the one conversion, which also means the
 * prefilled number obeys ADR-0005's whole-unit rounding for a cross-system
 * conversion — the same number the widget's own label shows. A patient who
 * switched systems therefore sees a rounded amount in the field and may save
 * it, which is a real (small) loss of precision against their original entry.
 * That is the correct direction: the field must show what will be saved, and
 * silently saving an un-rounded canonical value behind a rounded display would
 * be the alternative.
 *
 * ## Nothing here is trusted
 *
 * A param is a string from a URL. `parseDraftParams` validates every field and
 * returns `undefined` for anything it does not recognise, so a hand-typed or
 * stale deep link pre-fills nothing rather than half of something. The entry
 * screen then behaves exactly as it does when opened from the dashboard
 * button, which is the only safe fallback — and the screens re-validate on
 * save regardless, because a prefill is as untrusted as typing.
 */

/** Where a suggestion's draft opens. */
export function draftRouteFor(code: string): string | undefined {
  if (code === STOMA_OUTPUT_LOINC_CODE) return '/add-output';
  if (code === FLUID_INTAKE_LOINC_CODE) return '/add-intake';
  if (code === VOIDED_URINE_LOINC_CODE) return '/add-urine';
  return undefined;
}

export interface DraftParams {
  /** The display-unit amount, as the field should show it. Absent on a colour-only urine draft. */
  readonly amount?: string;
  readonly method?: MeasuredOrEstimated;
  readonly fluidType?: string;
  readonly urineColor?: string;
}

/** The query string for a suggestion's draft, or `undefined` if its code has no screen. */
export function draftHrefFor(
  suggestion: QuickAddSuggestion,
  displaySystem: MeasurementSystem,
): string | undefined {
  const route = draftRouteFor(suggestion.code);
  if (route === undefined) return undefined;

  const params = new URLSearchParams();
  if (suggestion.kind === 'volumetric') {
    const display = convertVolumeForDisplay(
      Number(suggestion.canonicalValue),
      unitsForMeasurementSystem(suggestion.enteredMeasurementSystem),
      unitsForMeasurementSystem(displaySystem),
    );
    params.set('amount', String(display.value));
    params.set('method', suggestion.method);
    if (suggestion.fluidTypeCode !== null) params.set('fluidType', suggestion.fluidTypeCode);
    if (suggestion.urineColorCode !== null) params.set('urineColor', suggestion.urineColorCode);
  } else {
    params.set('urineColor', suggestion.urineColorCode);
  }
  // `quickAdd=1` is not read by anything and is deliberately absent: a param
  // nothing consumes is a param someone later branches on.
  return `${route}?${params.toString()}`;
}

/**
 * Reads the params an entry screen was opened with.
 *
 * Every field is checked. `amount` in particular must look like a number the
 * numeric field would accept — a param of `"1e9"` or `"abc"` pre-filled
 * verbatim would put the patient in front of a field they did not fill and
 * cannot interpret, and Tier 1's precision rules would then refuse it with a
 * message about something they never typed.
 */
export function parseDraftParams(raw: {
  readonly amount?: string | string[] | undefined;
  readonly method?: string | string[] | undefined;
  readonly fluidType?: string | string[] | undefined;
  readonly urineColor?: string | string[] | undefined;
}): DraftParams {
  const parsed: {
    amount?: string;
    method?: MeasuredOrEstimated;
    fluidType?: string;
    urineColor?: string;
  } = {};

  const amount = single(raw.amount);
  // A plain decimal, nothing else: no sign, no exponent, no whitespace. The
  // screens' own `NumericField` accepts what a patient can type, and this is
  // the same shape.
  if (amount !== undefined && /^\d+(\.\d+)?$/.test(amount)) parsed.amount = amount;

  const method = single(raw.method);
  // Compared against the two literals rather than cast. A `method` of anything
  // else would set the mandatory toggle to a value the screen cannot render as
  // a selected choice, leaving it silently unanswered with no error.
  if (method === 'measured' || method === 'estimated') parsed.method = method;

  // A value-set member code is not checkable here — the cache is the authority
  // and this module has no database. The screens resolve a code against the
  // cached members and render nothing selected for one they do not find, which
  // is the same thing they already do for a member retired since the entry was
  // made (CLAUDE.md: retirement is expressed by absence).
  const fluidType = single(raw.fluidType);
  if (fluidType !== undefined && fluidType !== '') parsed.fluidType = fluidType;

  const urineColor = single(raw.urineColor);
  if (urineColor !== undefined && urineColor !== '') parsed.urineColor = urineColor;

  return parsed;
}

/** Expo Router hands a repeated param as an array. Take the first; a repeat is a malformed link, not an instruction. */
function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
