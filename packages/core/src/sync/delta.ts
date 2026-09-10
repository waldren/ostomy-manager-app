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

import type { EntityId, ServerSequence } from './identifiers.js';
import type { SyncEntityType, SyncPayloadByEntityType, WireInstant } from './payload.js';

/**
 * `GET /api/v1/sync/delta` — `docs/sync-contract.md` §5.
 */

export interface SyncDeltaRequest {
  /**
   * Server sequence, **exclusive**. `"0"` requests everything — the
   * initial sync of a newly installed or reinstalled app (§5.1).
   *
   * A `ServerSequence`, so it can only have come from a previous delta
   * response's `cursor`. §3.6 and §9.4: a client MUST NOT advance its
   * cursor from a push receipt. The type cannot tell the two apart — both
   * are `ServerSequence` — but naming this `since: ServerSequence` at
   * least keeps a raw string or a `number` out of it.
   */
  readonly since: ServerSequence;
  /**
   * Page size (§5.1). The default and maximum are server configuration and
   * are deliberately not named as values here: this package names shapes,
   * never values.
   */
  readonly limit?: number;
}

interface SyncDeltaChangeCommonFields {
  readonly entityId: EntityId;
  readonly serverSequence: ServerSequence;
  /**
   * The client timestamp of the write that produced this version — what
   * last-write-wins compares against (§4).
   *
   * On BOTH arms, including a tombstone, where it is the client timestamp
   * of the operation that deleted the row rather than a server receipt
   * time (§5.2). A device holding an unpushed local edit to an entity it
   * has just been told is deleted has to resolve that itself, by the same
   * rule the server applies, and it cannot do that against a clock it does
   * not share. The server's own `deletedAt` is bookkeeping and does not
   * cross the wire, for the same reason `createdAt` and `updatedAt` do
   * not (§7.2).
   */
  readonly clientUpdatedAt: WireInstant;
}

type SyncDeltaUpsertFor<TEntityType extends SyncEntityType> = SyncDeltaChangeCommonFields & {
  readonly entityType: TEntityType;
  readonly deleted: false;
  readonly payload: SyncPayloadByEntityType[TEntityType];
};

/** A live row. Distributed over `SyncEntityType` so `entityType` and `payload` cannot disagree. */
export type SyncDeltaUpsert = {
  [TEntityType in SyncEntityType]: SyncDeltaUpsertFor<TEntityType>;
}[SyncEntityType];

/**
 * A deleted row (§5.2).
 *
 * **This type has no `payload` property at all** — not an optional one,
 * not one narrowed to `never`. §5.2: "A tombstone carries no `payload`.
 * The receiving device needs the entity id to remove its local row and
 * nothing else; sending the clinical values of a deleted entry would
 * transmit PHI that serves no purpose, and the minimum-necessary rule
 * applies to a protocol as much as to a screen."
 *
 * An optional `payload?:` would put the decision at every call site that
 * builds one; the absence of the property puts it in the build.
 * `tombstone-carries-no-payload.type-test.ts` fails typecheck if it is
 * ever added back.
 */
export interface SyncDeltaTombstone extends SyncDeltaChangeCommonFields {
  readonly entityType: SyncEntityType;
  readonly deleted: true;
}

export type SyncDeltaChange = SyncDeltaUpsert | SyncDeltaTombstone;

export interface SyncDeltaResponse {
  /** Ordered by `serverSequence` ascending (§5.2). */
  readonly changes: readonly SyncDeltaChange[];
  /**
   * The highest sequence the server is willing to let the client advance
   * to (§5.3) — **not necessarily the highest in `changes`**, and never
   * derived by the client from the rows it received.
   *
   * Normative invariant: if a client's cursor is `C`, the client has been
   * shown every change for that patient with server sequence ≤ `C`. §5.3
   * records that this does not hold for free — PostgreSQL sequences are
   * non-transactional, so a reader can see 48214 committed while 48213 is
   * still in flight — and makes implementing a mechanism that closes it,
   * plus an out-of-order-commit test, an obligation of P2.S1b. This type
   * fixes the guarantee; it cannot fix the mechanism.
   */
  readonly cursor: ServerSequence;
  /** The client pulls in a loop until this is `false`, persisting `cursor` after each page (§5.2). */
  readonly hasMore: boolean;
}

/**
 * Narrowing a change to its tombstone arm. Provided because the
 * alternative a consumer reaches for is a cast, and a cast is how a
 * `payload` read gets written against a tombstone that has none.
 */
export function isSyncDeltaTombstone(change: SyncDeltaChange): change is SyncDeltaTombstone {
  return change.deleted;
}

export function isSyncDeltaUpsert(change: SyncDeltaChange): change is SyncDeltaUpsert {
  return !change.deleted;
}
