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

import type { ObservationSyncPayload, SyncPushOperation, SyncPushRequest } from '@ostomy/core/sync';
import { toEntityId, toOperationId } from '@ostomy/core/sync';

import type { SqliteExecutor } from '../db/executor';
import { getObservationById, markServerSequence } from '../db/repositories/observationsRepository';
import {
  markRejected,
  recordAttempt,
  removeOperation,
  revertToQueued,
} from '../db/repositories/syncQueueRepository';
import type { LocalObservation, SyncQueueEntry } from '../db/types';

import type { DecodedPushResult } from './responseDecoding';

/**
 * Turning queue rows into a `docs/sync-contract.md` §3.1 push request, and
 * a §3.4 response back into local state.
 *
 * The two halves are deliberately separate functions with no network call
 * between them: `buildPushRequest` is pure given the rows it reads, and
 * `applyPushResults` is the only place in this app that decides a queued
 * operation's local fate. Keeping that decision in one function is what
 * makes §9's "what a client must never do" list checkable — a reviewer
 * reads `applyPushResults` and sees every branch.
 */

/**
 * An operation whose entity row has vanished from `observations`.
 *
 * Not reachable today: `db/offlineWrites.ts` writes the row and the queue
 * entry in one transaction, and nothing deletes an observation row (a
 * delete tombstones it in place, §1). It is a reported outcome rather than
 * a thrown error because the alternative — letting one unbuildable
 * operation throw out of the batch build — would stall every operation
 * queued behind it, forever, with no diagnostic. The queue row stays put.
 */
export interface UnbuildableOperation {
  readonly operationId: string;
  readonly entityId: string;
  readonly reason: 'entity-row-missing';
}

export interface BuiltPushRequest {
  readonly request: SyncPushRequest;
  /** The queue rows the request actually carries, in request order — the caller needs these to mark attempts and to correlate results. */
  readonly sent: readonly SyncQueueEntry[];
  readonly unbuildable: readonly UnbuildableOperation[];
}

/**
 * Builds the wire request for one batch.
 *
 * The payload is assembled **here, at push time**, from the current
 * `observations` row — never from anything frozen at enqueue. Local
 * migration 2 removed `sync_queue.payload` for exactly this reason: a
 * frozen payload is immune to a change in `docs/sync-contract.md`, which is
 * normative and does change, and ADR-0016 was the live case that proved it.
 * See `db/schema.ts`'s migration-2 comment.
 */
export async function buildPushRequest(
  executor: SqliteExecutor,
  batch: readonly SyncQueueEntry[],
): Promise<BuiltPushRequest> {
  const operations: SyncPushOperation[] = [];
  const sent: SyncQueueEntry[] = [];
  const unbuildable: UnbuildableOperation[] = [];

  for (const entry of batch) {
    if (entry.operationType === 'delete') {
      // §3.1: `payload` is ABSENT for a delete — not null, not an empty
      // object. The key must not appear at all, or §6.1's
      // PAYLOAD_PRESENCE_INVALID fails the whole request.
      operations.push({
        operationId: toOperationId(entry.operationId),
        entityId: toEntityId(entry.entityId),
        entityType: 'Observation',
        operationType: 'delete',
        clientTimestamp: entry.clientTimestamp,
      });
      sent.push(entry);
      continue;
    }

    const observation = await getObservationById(executor, entry.entityId);
    if (observation === undefined) {
      unbuildable.push({
        operationId: entry.operationId,
        entityId: entry.entityId,
        reason: 'entity-row-missing',
      });
      continue;
    }

    operations.push({
      operationId: toOperationId(entry.operationId),
      entityId: toEntityId(entry.entityId),
      entityType: 'Observation',
      operationType: entry.operationType,
      clientTimestamp: entry.clientTimestamp,
      payload: toObservationPayload(observation),
    });
    sent.push(entry);
  }

  return { request: { operations }, sent, unbuildable };
}

/**
 * Projects a local row onto the §7.2 wire payload, field by field.
 *
 * **Never a spread.** TypeScript's excess-property check does not apply to
 * spread properties, so `{ ...observation, status: 'final' }` typechecks
 * cleanly and ships `serverSequence`, `deletedAt`, `createdAt`,
 * `updatedAt` and `localDate` — several of which §7.2 names as
 * `PAYLOAD_FIELD_UNRECOGNIZED`, and one of which (`localDate`) the contract
 * singles out as a second source of truth whose disagreement nothing
 * detects. This is the same rule `packages/core/src/sync`'s constructors
 * enforce server-side, for the same reason (§6.3).
 */
function toObservationPayload(observation: LocalObservation): ObservationSyncPayload {
  return {
    resourceType: 'Observation',
    id: toEntityId(observation.id),
    status: 'final',
    code: observation.code,
    valueQuantity: {
      // §7.3: a JSON number on the wire, an exact decimal string at rest.
      // This is the one place that conversion is allowed to happen — see
      // `db/schema.ts`'s migration-1 numeric-precision comment.
      value: Number(observation.valueQuantityValue),
      unit: observation.valueQuantityUnit,
    },
    effectiveDateTime: observation.effectiveDatetime,
    method: observation.method,
    enteredMeasurementSystem: observation.enteredMeasurementSystem,
    enteredTimezone: observation.enteredTimezone,
  };
}

/** What one push produced, for the caller's bookkeeping. Counts only — never an operation's content (§6.3). */
export interface PushOutcome {
  readonly accepted: number;
  readonly superseded: number;
  readonly rejected: number;
  /** Results naming an operation this device did not send in this batch. See `applyPushResults`. */
  readonly unrecognized: number;
}

/**
 * Marks a batch in flight before it is sent.
 *
 * Separate from the send so a crash mid-request leaves an honest
 * `attemptCount` and an `in_flight` status rather than a row that looks
 * untried. §9.3 is what makes resuming from that safe: a network failure or
 * a `5xx` leaves the operation's fate unknown, and the recovery is to
 * re-push and let idempotency settle it (§3.7) — never to treat it as
 * rejected.
 */
export async function markBatchInFlight(
  executor: SqliteExecutor,
  batch: readonly SyncQueueEntry[],
  attemptedAt: string,
): Promise<void> {
  for (const entry of batch) {
    await recordAttempt(executor, entry.operationId, attemptedAt);
  }
}

/**
 * Returns every operation in a batch to `queued` after a failure whose
 * outcome is unknown — a network error, a `5xx`, or a protocol error, which
 * §6.1 guarantees applied **no** operations.
 *
 * §9.3: an unknown fate is not a rejection. Marking these rejected would
 * put uncorrectable entries in front of a patient for a server or transport
 * problem they had no part in.
 */
export async function returnBatchToQueue(
  executor: SqliteExecutor,
  batch: readonly SyncQueueEntry[],
): Promise<void> {
  for (const entry of batch) {
    await revertToQueued(executor, entry.operationId);
  }
}

/**
 * Applies one §3.4 response to local state — the only function that decides
 * a queued operation's fate.
 *
 * Results are correlated by `operationId`, **not by array position**. §3.4
 * does promise one result per operation in request order, and relying on
 * that would work against a correct server; but position-correlation fails
 * silently and catastrophically against a server that ever returns a short
 * or reordered array — the wrong operation is removed from the queue and
 * the wrong one is marked rejected, and nothing downstream can detect it
 * because both rows are well-formed afterwards. Correlating by id costs a
 * map and cannot go wrong that way.
 *
 * Each applied result is settled in its own transaction together with the
 * server-sequence stamp it implies, so a crash between two results leaves
 * the earlier ones settled and the later ones still queued — which a
 * re-push resolves through idempotency (§3.7).
 */
export async function applyPushResults(
  executor: SqliteExecutor,
  sent: readonly SyncQueueEntry[],
  results: readonly DecodedPushResult[],
  appliedAt: string,
): Promise<PushOutcome> {
  const sentIds = new Set(sent.map((entry) => entry.operationId));
  let accepted = 0;
  let superseded = 0;
  let rejected = 0;
  let unrecognized = 0;

  for (const result of results) {
    if (result.kind === 'undecodable') {
      // Settles nothing (`responseDecoding.ts`). The operation stays where it
      // is and the caller returns it to the queue with everything else the
      // response failed to name — §9.3's unknown fate, not a rejection.
      unrecognized += 1;
      continue;
    }

    if (!sentIds.has(result.operationId)) {
      // A result for something this device did not just send. Counted and
      // otherwise ignored: acting on it would mean mutating a queue row
      // named by an id this batch did not choose, and the only rows this
      // batch is entitled to settle are the ones it sent.
      unrecognized += 1;
      continue;
    }

    if (result.kind === 'rejected') {
      // §3.5 / §9.1: RETAINED and surfaced for correction, never dropped
      // and never silently retried unchanged (§9.2). `markRejected` updates
      // in place so `localSeq` — and therefore this row's position relative
      // to whatever was queued around it — survives.
      await markRejected(executor, result.operationId, {
        reasonCode: result.reasonCode,
        field: result.field,
        rejectedAt: appliedAt,
      });
      rejected += 1;
      continue;
    }

    // `accepted` and `superseded` are both "remove from the queue" (§3.5).
    // `superseded` is not an error and there is nothing to correct: a newer
    // version of the entity already exists server-side, and routing it to
    // the correction inbox would ask a patient to fix an entry that was
    // never wrong.
    await executor.withTransactionAsync(async () => {
      // The receipt names where the ENTITY row landed (§3.6) — for a
      // `superseded` result that is the WINNING row's sequence, not this
      // operation's. Stamping it is right either way: it is the sequence
      // this device's copy of that entity now corresponds to.
      //
      // It is emphatically NOT a cursor. Nothing here touches
      // `sync_cursor`; see `db/repositories/syncCursorRepository.ts`'s
      // header comment and §3.6 for what advancing from a receipt would
      // silently skip.
      await markServerSequence(executor, result.entityId, result.appliedServerSequence);
      await removeOperation(executor, result.operationId);
    });

    if (result.status === 'accepted') accepted += 1;
    else superseded += 1;
  }

  return { accepted, superseded, rejected, unrecognized };
}
