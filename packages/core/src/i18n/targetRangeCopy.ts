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
 * Which catalog strings describe a target range (SRS §3.9), shared by both
 * clients (P4.S3 slice 4).
 *
 * The STRINGS are already shared, in `common`. This is the choosing: which
 * label a range type gets, and which of three basis sentences a post-operative
 * day reads as. Written once here because the web and the phone each choosing
 * for themselves is how one of them comes to say "about 3 months" while the
 * other says "once things have settled" about the same patient on the same day.
 *
 * Returns keys and parameters rather than text: this module has no translator,
 * and the clients pass the keys to their own.
 */

/**
 * The range types this release names. In the `common` namespace explicitly:
 * the web's default namespace is `web`, which holds shell copy only.
 */
const RANGE_TYPE_LABEL_KEYS: Readonly<Record<string, string>> = {
  daily_output_ml: 'common:rangeType.daily_output_ml',
  urine_output_adequacy_ml: 'common:rangeType.urine_output_adequacy_ml',
  net_fluid_balance_ml: 'common:rangeType.net_fluid_balance_ml',
};

/** A range type's label key, or the "another measure" key for one this release does not name. */
export function rangeTypeLabelKey(rangeType: string): string {
  return Object.hasOwn(RANGE_TYPE_LABEL_KEYS, rangeType)
    ? (RANGE_TYPE_LABEL_KEYS[rangeType] as string)
    : 'common:rangeType.unknownMeasure';
}

/** Roughly, for a basis sentence that says "about". A span of days does not deserve precision. */
const DAYS_PER_MONTH = 30;
const SETTLED_AFTER_MONTHS = 6;

export interface RangeBasisCopy {
  readonly key: string;
  /**
   * The ostomy type's key, to translate and pass as `ostomyType`. It carries
   * its own article ("an ileostomy"), because which article a noun takes is a
   * property of the noun, and "a {{ostomyType}}" produced "a ileostomy".
   */
  readonly ostomyTypeKey: string;
  /** Present only for the "about N months" sentence. */
  readonly months?: number;
}

/** The basis sentence for a suggestion: what is typical, never what to do (§3.9). */
export function rangeBasisCopy(basis: {
  readonly ostomyType: 'colostomy' | 'ileostomy';
  readonly daysPostOp: number;
}): RangeBasisCopy {
  const ostomyTypeKey =
    basis.ostomyType === 'colostomy'
      ? 'common:ostomyType.colostomyLower'
      : 'common:ostomyType.ileostomyLower';
  const months = Math.round(basis.daysPostOp / DAYS_PER_MONTH);

  if (months < 1) return { key: 'common:targetRanges.basisEarly', ostomyTypeKey };
  if (months >= SETTLED_AFTER_MONTHS)
    return { key: 'common:targetRanges.basisSettled', ostomyTypeKey };
  return { key: 'common:targetRanges.basisMonths', ostomyTypeKey, months };
}

/**
 * Which band sentence a range reads as, from which bounds it has. A floor with
 * no ceiling is the ordinary shape for urine and net balance, so "at least X"
 * is first-class rather than a band with a blank half. `null` for a range with
 * neither, which #97's CHECK makes unreachable for a stored row.
 */
export function rangeBandKey(bounds: {
  readonly hasLow: boolean;
  readonly hasHigh: boolean;
}): string | null {
  if (bounds.hasLow && bounds.hasHigh) return 'common:targetRanges.band';
  if (bounds.hasLow) return 'common:targetRanges.atLeast';
  if (bounds.hasHigh) return 'common:targetRanges.atMost';
  return null;
}
