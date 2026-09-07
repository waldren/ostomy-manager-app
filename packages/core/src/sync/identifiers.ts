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
 * The three identifier types the sync wire carries, each branded so the
 * two confusions `docs/sync-contract.md` names by hand become compile
 * errors rather than review comments.
 *
 * Branding costs one call at each mint/decode boundary
 * (`toOperationId(randomUUID())`, `toServerSequence(rowFromSqlite.cursor)`).
 * That is the whole cost, and it is paid where a value crosses from
 * untyped storage or an untyped JSON body into the protocol — which is
 * exactly where a check belongs anyway.
 */

/**
 * Server sequence — the delta cursor's value type (§1, §7.3).
 *
 * **A `string`, never a `number`, and the brand is what makes that
 * enforceable.** §7.3: these are 64-bit database values, JSON numbers are
 * IEEE-754 doubles, and `JSON.parse` silently loses precision above 2^53.
 * The loss surfaces years later as a cursor that stops advancing, with no
 * error. A plain `string` alias would leave `Number(cursor) + 1` and
 * `serverSequence: 48213` as ordinary, compiling code; the brand makes
 * both a type error at the point they are written. `isServerSequenceAfter`
 * below exists so the comparison a client actually needs never has to go
 * through `Number()` to get it.
 */
export type ServerSequence = string & { readonly __syncBrand: 'ServerSequence' };

/**
 * Operation id — a UUID the client mints **when the operation is
 * enqueued**, and "never the entity id" (§1, ADR-0001 point 1).
 *
 * That prohibition is why this is branded distinctly from `EntityId`
 * rather than both being `string`. Reusing an entity id as an operation id
 * makes every later edit of that row look like a replay of the first
 * write, so the edit is discarded with an `accepted`-shaped result and no
 * error anywhere — ADR-0001's "silently lost edits, not an error". A
 * distinct brand turns that into a compile error at the one line where the
 * mistake is made.
 */
export type OperationId = string & { readonly __syncBrand: 'OperationId' };

/** Entity id — the UUID of the row an operation acts on, client-generated at create time and stable across every later update (§1). */
export type EntityId = string & { readonly __syncBrand: 'EntityId' };

/**
 * Canonical lowercase UUID form. A lexical shape check at the decode
 * boundary, not a validation rule: server-side entity validation is
 * `apps/api`'s job (§2), and nothing here consults a threshold.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A non-negative decimal integer with no leading zeros — the only form §7.3 puts on the wire. */
const SERVER_SEQUENCE_PATTERN = /^(0|[1-9][0-9]*)$/;

export function isOperationId(value: unknown): value is OperationId {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isEntityId(value: unknown): value is EntityId {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

export function isServerSequence(value: unknown): value is ServerSequence {
  return typeof value === 'string' && SERVER_SEQUENCE_PATTERN.test(value);
}

/**
 * Every `to*` helper below throws a message naming the expected shape and
 * never the rejected value. The rejected value is attacker-controlled
 * input from an untrusted device (§2) and this message reaches an
 * application log — "never log PHI" is a habit that has to hold for the
 * near misses too, or it does not hold.
 */
export function toOperationId(value: string): OperationId {
  if (!isOperationId(value)) {
    throw new TypeError('operationId must be a canonical UUID string.');
  }
  return value;
}

export function toEntityId(value: string): EntityId {
  if (!isEntityId(value)) {
    throw new TypeError('entityId must be a canonical UUID string.');
  }
  return value;
}

export function toServerSequence(value: string): ServerSequence {
  if (!isServerSequence(value)) {
    throw new TypeError(
      'serverSequence must be a non-negative decimal integer string (§7.3) — never a JSON number.',
    );
  }
  return value;
}

/**
 * `candidate > cursor`, compared as arbitrary-precision integers.
 *
 * Exists so that the one comparison a client genuinely needs — "have I
 * already seen this row?" — has an answer that does not route through
 * `Number()`. Lexicographic string comparison is wrong here ("9" > "48213"),
 * and `Number()` is the precision loss §7.3 exists to prevent, so without
 * this helper every consumer writes one of the two bugs.
 */
export function isServerSequenceAfter(candidate: ServerSequence, cursor: ServerSequence): boolean {
  return BigInt(candidate) > BigInt(cursor);
}
