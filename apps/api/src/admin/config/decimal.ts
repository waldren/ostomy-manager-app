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
 * Projecting a `DECIMAL(12,4)` column to a JSON number, for the admin config surface.
 *
 * Its own module rather than living in either wire contract, because both need it and
 * the alternative was a wire-to-wire dependency: `admin-thresholds.service.ts` imported
 * this from `admin-value-set-wire.ts`, which sat oddly beside that module's own
 * argument that the two surfaces are separate contracts (PR B review).
 *
 * Two functions rather than one, because the nullability differs by column and that
 * difference belongs in the type rather than in a cast. A value-set member's quantity
 * is nullable — a category carries no number — while `validation_thresholds.value` is
 * `NOT NULL`. The threshold service previously wrote `toNumericValue(row.value) as
 * number`, and the cast rather than the declaration was what made it compile: making
 * the row type nullable later would keep compiling while `null` flowed into the audit
 * JSON and into a response the schema declares as `z.number()`.
 *
 * A number and not a string, for `docs/sync-contract.md` §7.3's reason: a clinical
 * value stays a number, and making it a string pushes parsing onto every consumer.
 * These are `DECIMAL(12,4)` values far inside a double's exact range.
 */

/** A Prisma `Decimal`, structurally — avoids importing the client into a wire module. */
export interface DecimalLike {
  toNumber: () => number;
}

/** For a nullable column. `null` stays `null`, never zero: a missing quantity is not a quantity of zero. */
export function toNumericValue(value: DecimalLike | null): number | null {
  return value === null ? null : value.toNumber();
}

/** For a `NOT NULL` column, so no caller needs a cast to express what the schema already guarantees. */
export function toRequiredNumber(value: DecimalLike): number {
  return value.toNumber();
}
