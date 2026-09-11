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
 * The bounds of what a canonical volume can be *stored as*, and the two
 * predicates Tier 1 uses to enforce them.
 *
 * **These are not thresholds, and this file is not an exception to the
 * threshold-injection rule.** `no-hardcoded-thresholds.spec.ts` allow-lists
 * it for the same reason `tier1.ts`'s `checkValueIsPositive` may compare
 * against `0`: these numbers are structural facts about the shape of the
 * data, not clinical judgements. `observations.value_quantity_value` is
 * `DECIMAL(12,4)`. A clinician cannot make it hold `10^8`, and an admin
 * changing a configured value would not change the column — so making
 * these injectable would model them as adjustable when they are not, which
 * is a worse lie than a literal.
 *
 * The clinical bound — "is 2,500 mL plausible for this patient" — is a
 * genuine admin-managed threshold and lives in `VolumetricValidationThresholds`
 * as Tier 2. Nothing clinical belongs in this file. `no-hardcoded-thresholds.spec.ts`
 * pins its exported surface so it cannot quietly become a home for one.
 *
 * **Why Tier 1 rather than letting the database refuse it.** Both of these
 * inputs pass every other Tier 1 rule, so before this module they reached
 * Postgres and failed there: `10^8` as `numeric field overflow`, and
 * `0.00004` by rounding to `0.0000` and violating the positivity CHECK.
 * Neither is a Prisma `P2002`, so both surfaced as HTTP 500 — and
 * `docs/sync-contract.md` §9 tells a client to treat a 5xx as an unknown
 * outcome and **re-push**. A mistyped `123456789` therefore became an
 * operation that retried forever and never reached the correction inbox,
 * which is the exact inverse of AC 13.1 AC4. A Tier 1 rejection is
 * correctable; a 500 is not.
 */

/**
 * Exclusive upper bound. `DECIMAL(12,4)` holds 12 significant digits with 4
 * after the point, so the largest storable value is `99999999.9999` — i.e.
 * anything that rounds to `10^8` or more overflows. Postgres states it in
 * exactly those terms: "must round to an absolute value less than 10^8".
 */
export const MAX_REPRESENTABLE_VALUE_ML = 100000000;

/**
 * The column's scale. A value with more fractional digits than this is not
 * stored as entered — Postgres rounds it silently, in both directions, with
 * no error and no signal to either side. That silent rounding is what makes
 * this a Tier 1 rule rather than a tolerated nicety: CLAUDE.md and ADR-0005
 * both state that stored values keep their entered precision, and a
 * `350.12345` quietly becoming `350.1235` breaks that claim without anyone
 * being able to observe it afterwards.
 */
export const MAX_VALUE_DECIMAL_PLACES = 4;

/**
 * Fractional digits in `value`'s shortest round-trip decimal form.
 *
 * Reads `Number.prototype.toString()` rather than doing arithmetic, because
 * arithmetic on a binary float is exactly what this needs to avoid: the
 * question is how many digits the patient's entry actually carries, and
 * `toString()` gives the shortest decimal that round-trips to the same
 * double — which is that entry. Exponent forms (`1e-7`, `1.5e-7`) are
 * normalised rather than mis-measured; `String(1e-7)` is `"1e-7"`, whose
 * `indexOf('.')` is `-1` and would otherwise read as zero decimal places.
 */
export function decimalPlaces(value: number): number {
  const text = Math.abs(value).toString();

  const exponentForm = /^(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(text);
  if (exponentForm !== null) {
    const fractionDigits = exponentForm[2]?.length ?? 0;
    const exponent = Number(exponentForm[3]);
    return Math.max(0, fractionDigits - exponent);
  }

  const pointIndex = text.indexOf('.');
  return pointIndex === -1 ? 0 : text.length - pointIndex - 1;
}

/** `true` when `value` is at or beyond what the column can hold (see `MAX_REPRESENTABLE_VALUE_ML`). */
export function exceedsMaxMagnitude(value: number): boolean {
  return Math.abs(value) >= MAX_REPRESENTABLE_VALUE_ML;
}

/** `true` when `value` carries more fractional digits than the column preserves (see `MAX_VALUE_DECIMAL_PLACES`). */
export function exceedsMaxPrecision(value: number): boolean {
  return decimalPlaces(value) > MAX_VALUE_DECIMAL_PLACES;
}
