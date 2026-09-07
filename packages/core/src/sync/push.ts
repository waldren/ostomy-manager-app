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

import type { SyncFieldPath } from './fieldPaths.js';
import type { EntityId, OperationId, ServerSequence } from './identifiers.js';
import type { SyncEntityType, SyncPayloadByEntityType, WireInstant } from './payload.js';
import type { SyncReasonCode } from './reasonCodes.js';

/**
 * `POST /api/v1/sync/push` — `docs/sync-contract.md` §3.
 *
 * There is no patient identifier anywhere in these types, deliberately:
 * §2 requires the patient be derived from the token and the server MUST
 * NOT accept one from the payload. "This is not defense in depth — it is
 * the absence of the field that could carry the attack."
 */

export const SYNC_OPERATION_TYPE = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
} as const;

export type SyncOperationType = (typeof SYNC_OPERATION_TYPE)[keyof typeof SYNC_OPERATION_TYPE];

interface SyncOperationCommonFields {
  /** Minted at enqueue, once (§1, §9.7). The idempotency key, in combination with the patient the token names (§3.7). */
  readonly operationId: OperationId;
  readonly entityId: EntityId;
  /**
   * The client's wall-clock reading of when the **write** was made —
   * distinct from the payload's `effectiveDateTime`, the clinical moment
   * the observation describes (§1). Conflict resolution uses this one;
   * clinical display uses the other. Collapsing the two is the mistake §1
   * calls load-bearing.
   */
  readonly clientTimestamp: WireInstant;
}

/**
 * Distributed over `SyncEntityType` so `entityType` and `payload` cannot
 * disagree: a `create` declaring one entity type cannot carry another's
 * payload.
 */
type SyncWriteOperation<
  TOperationType extends 'create' | 'update',
  TEntityType extends SyncEntityType,
> = SyncOperationCommonFields & {
  readonly entityType: TEntityType;
  readonly operationType: TOperationType;
  readonly payload: SyncPayloadByEntityType[TEntityType];
};

export type SyncCreateOperation = {
  [TEntityType in SyncEntityType]: SyncWriteOperation<'create', TEntityType>;
}[SyncEntityType];

export type SyncUpdateOperation = {
  [TEntityType in SyncEntityType]: SyncWriteOperation<'update', TEntityType>;
}[SyncEntityType];

/**
 * A delete has **no `payload` property at all** — not an optional one.
 * §3.1: "payload is absent for operationType: delete", and §6.1 makes a
 * payload present on a delete a whole-request protocol error. Deletes are
 * tombstones (§1), so there is nothing for a payload to say.
 */
export type SyncDeleteOperation = SyncOperationCommonFields & {
  readonly entityType: SyncEntityType;
  readonly operationType: 'delete';
};

export type SyncPushOperation = SyncCreateOperation | SyncUpdateOperation | SyncDeleteOperation;

/**
 * The array MUST be non-descending in `clientTimestamp` and is applied in
 * array order; the server does not reorder (§3.2). Equal timestamps are
 * permitted and resolved by array order. A descending array is a protocol
 * error, not a per-operation rejection — the client's queue processor is
 * broken and there is nothing a patient could correct.
 *
 * At most `SYNC_PUSH_MAX_OPERATIONS` operations (§3.3). That bound is
 * environment configuration and is deliberately not named as a value
 * anywhere in this package.
 */
export interface SyncPushRequest {
  readonly operations: readonly SyncPushOperation[];
}

export const SYNC_RESULT_STATUS = {
  ACCEPTED: 'accepted',
  SUPERSEDED: 'superseded',
  REJECTED: 'rejected',
} as const;

export type SyncResultStatus = (typeof SYNC_RESULT_STATUS)[keyof typeof SYNC_RESULT_STATUS];

interface SyncResultCommonFields {
  readonly operationId: OperationId;
  readonly entityId: EntityId;
  /**
   * Diagnostic only, and always present (§3.7). A re-pushed operation
   * returns the result the first attempt produced, byte-for-byte apart
   * from this flag. A client MUST NOT branch clinical behaviour on it.
   */
  readonly replayed: boolean;
}

/**
 * Applied. The row now reflects this operation; the client removes it from
 * the queue (§3.5).
 */
export interface SyncAcceptedResult extends SyncResultCommonFields {
  readonly status: 'accepted';
  /**
   * A **receipt, not a cursor** (§3.6). It names the server sequence of
   * the entity row as it stands after this operation was processed. A
   * client MUST NOT advance its delta cursor from it: the sequence is
   * assigned globally across patients and rows, so a value observed here
   * says nothing about which other rows have become visible, and advancing
   * from it would skip every row written between the last delta pull and
   * this batch.
   */
  readonly appliedServerSequence: ServerSequence;
}

/**
 * Valid, processed, **not applied** — a newer version of the same entity
 * already exists (§4). The client removes it from the queue. Not an error;
 * nothing to correct.
 *
 * A third status because it is a third thing (§3.5): reporting a lost
 * write as `accepted` tells the client its version is live when it is not,
 * and reporting it as `rejected` asks a patient to fix an entry that was
 * never wrong. The losing version is not discarded either way — it goes to
 * the audit log (§4).
 */
export interface SyncSupersededResult extends SyncResultCommonFields {
  readonly status: 'superseded';
  /** For a `superseded` result this is the **winning** row's sequence, not this operation's (§3.6). */
  readonly appliedServerSequence: ServerSequence;
}

/**
 * Refused by server-side validation or authorization. The client retains
 * it locally and surfaces it for correction (AC 13.1 AC4) — never drops
 * it, never silently retries it unchanged (§9.1, §9.2).
 *
 * **Every property on this type is a code, a flag, or an identifier.**
 * §6.3: a rejection "never carries the offending value, in any field, in
 * any encoding", because rejection responses are persisted by the client
 * and appear in client-side diagnostics — a value echoed here is PHI in a
 * log. `packages/core`'s `ValidationError` already makes this structurally
 * true for Tier 1, and this type holds the same shape for the same reason.
 * `rejected-result-carries-no-clinical-value.type-test.ts` fails the build
 * if a property is ever added.
 *
 * Note there is no `appliedServerSequence` here — see
 * `applied-server-sequence-absent-on-rejection.type-test.ts`. Nothing was
 * applied, so there is no receipt, and §3.6's "receipt, not a cursor" rule
 * is easier to violate when the field is merely optional everywhere.
 */
export interface SyncRejectedResult extends SyncResultCommonFields {
  readonly status: 'rejected';
  readonly reasonCode: SyncReasonCode;
  readonly field: SyncFieldPath;
}

export type SyncOperationResult = SyncAcceptedResult | SyncSupersededResult | SyncRejectedResult;

/**
 * `200 OK`, one result per operation, in request order (§3.4). A batch
 * never fails as a unit for data reasons (ADR-0001 point 2): one
 * implausible row — precisely the kind Tier 2 exists to let through — must
 * not block every subsequent entry a patient made while offline.
 */
export interface SyncPushResponse {
  readonly results: readonly SyncOperationResult[];
}

export function isAcceptedResult(result: SyncOperationResult): result is SyncAcceptedResult {
  return result.status === SYNC_RESULT_STATUS.ACCEPTED;
}

export function isSupersededResult(result: SyncOperationResult): result is SyncSupersededResult {
  return result.status === SYNC_RESULT_STATUS.SUPERSEDED;
}

export function isRejectedResult(result: SyncOperationResult): result is SyncRejectedResult {
  return result.status === SYNC_RESULT_STATUS.REJECTED;
}

/**
 * The two statuses that carry an `appliedServerSequence` (§3.6). Narrowing
 * through this is how a consumer reads the receipt without a cast — and it
 * is deliberately not named `hasCursor`, because it is not one.
 */
export function isAppliedResult(
  result: SyncOperationResult,
): result is SyncAcceptedResult | SyncSupersededResult {
  return !isRejectedResult(result);
}
