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

import type { DisplayVolume, DisplayWeight, VolumeUnit, WeightUnit } from '../units/types.js';
import { DEFAULT_LOCALE } from './constants.js';

/**
 * Intl-based formatting helpers (ADR-0006). Every date/time/number/unit
 * value rendered to a patient or clinician goes through one of these, so
 * locale-aware formatting is real from the first screen even though v1
 * ships only `en-US`.
 */

/**
 * `'short'` — the compact symbol (e.g. "70.9 kg"). `'long'` — the spelled-
 * out accessible name (e.g. "70.9 kilograms"). S2 (this sprint's review):
 * a screen reader announces the short form "kg" or "lb" as "K G" or "L B"
 * to a patient population that skews older and post-surgical, so any
 * accessible-name context (an ARIA label, an alt-text description of a
 * chart value) must request `'long'` explicitly rather than default to the
 * visually compact form.
 */
export type UnitDisplay = 'short' | 'long';

/**
 * `packages/core/src/i18n/locales/en/common.ts`'s `unit.*` keys are
 * intentionally NOT used here (S2, this sprint's review): unit wording is
 * sourced from `Intl.NumberFormat`'s `style: 'unit'`, which is
 * locale-aware and CLDR-correct, not from a hand-written English string
 * concatenated onto a number — the exact two-sources-of-truth divergence
 * ADR-0006 exists to prevent. If nothing else references `common.ts`'s
 * `unit.*` keys, they should be deleted rather than kept as a second,
 * unused source of unit wording.
 */
const INTL_UNIT_BY_VOLUME_UNIT: Record<VolumeUnit, string> = {
  mL: 'milliliter',
  oz: 'fluid-ounce',
};

const INTL_UNIT_BY_WEIGHT_UNIT: Record<WeightUnit, string> = {
  kg: 'kilogram',
  lb: 'pound',
};

export function formatNumber(
  value: number,
  locale: string = DEFAULT_LOCALE,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/**
 * Formats a date/time value with explicit, named defaults rather than
 * `Intl.DateTimeFormat`'s own unspecified defaults (nits, this sprint's
 * review): without `dateStyle`/`timeStyle`, the exact output is
 * implementation-defined and can omit the time entirely, which this
 * function's own name promises. `timeZone` also defaults explicitly
 * (`DEFAULT_TIME_ZONE`) rather than falling through to the host
 * environment's zone — the same FHIR `effectiveDateTime` rendered by the
 * API (likely UTC) and by a patient's device (their local zone) must not
 * silently disagree; callers that need the *viewer's* zone pass one
 * explicitly.
 */
const DEFAULT_TIME_ZONE = 'UTC';

export function formatDateTime(
  value: Date,
  locale: string = DEFAULT_LOCALE,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: DEFAULT_TIME_ZONE,
    ...options,
  }).format(value);
}

/**
 * `maximumFractionDigits: 4` caps DISPLAY precision only — it never
 * touches the canonical stored value (ADR-0004/ADR-0005: entry precision
 * is uncapped). The cap exists so a floating-point mL->mL same-system
 * readback (e.g. `../units`' `convertVolumeForDisplay` for an
 * imperial-entered value re-displayed in imperial) cannot show
 * arbitrary-length floating-point noise; 4 digits is more precision than
 * any volume entry workflow exposes (the finest granularity is a decimal
 * mL or oz entry), so it is a display safety net, not an active rounding
 * rule for any real entry.
 *
 * Formats a volume already resolved to its display unit and rounding
 * (`convertVolumeForDisplay` in `../units`) — this only renders the
 * number/unit pair for a locale; it never converts or rounds.
 */
export function formatVolumeQuantity(
  quantity: DisplayVolume,
  locale: string = DEFAULT_LOCALE,
  unitDisplay: UnitDisplay = 'short',
): string {
  return formatNumber(quantity.value, locale, {
    style: 'unit',
    unit: INTL_UNIT_BY_VOLUME_UNIT[quantity.unit],
    unitDisplay,
    maximumFractionDigits: 4,
  });
}

/**
 * Weight is always rendered to one decimal place, in both systems
 * (ADR-0005's weight carve-out) — this formatter enforces that at the
 * presentation layer too, independent of what `convertWeightForDisplay`
 * already rounded.
 */
export function formatWeightQuantity(
  quantity: DisplayWeight,
  locale: string = DEFAULT_LOCALE,
  unitDisplay: UnitDisplay = 'short',
): string {
  return formatNumber(quantity.value, locale, {
    style: 'unit',
    unit: INTL_UNIT_BY_WEIGHT_UNIT[quantity.unit],
    unitDisplay,
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
}
