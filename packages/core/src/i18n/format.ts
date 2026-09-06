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

import type { DisplayVolume, DisplayWeight } from '../units/types.js';
import { DEFAULT_LOCALE } from './constants.js';

/**
 * Intl-based formatting helpers (ADR-0006). Every date/time/number/unit
 * value rendered to a patient or clinician goes through one of these, so
 * locale-aware formatting is real from the first screen even though v1
 * ships only `en-US`.
 */

export function formatNumber(
  value: number,
  locale: string = DEFAULT_LOCALE,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

export function formatDateTime(
  value: Date,
  locale: string = DEFAULT_LOCALE,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, options).format(value);
}

/**
 * Formats a volume already resolved to its display unit and rounding
 * (`convertVolumeForDisplay` in `../units`) — this only renders the
 * number/unit pair for a locale; it never converts or rounds.
 */
export function formatVolumeQuantity(
  quantity: DisplayVolume,
  locale: string = DEFAULT_LOCALE,
): string {
  return `${formatNumber(quantity.value, locale, { maximumFractionDigits: 4 })} ${quantity.unit}`;
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
): string {
  const formattedNumber = formatNumber(quantity.value, locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  return `${formattedNumber} ${quantity.unit}`;
}
