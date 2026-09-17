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

import type { SqliteExecutor } from '../executor';
import {
  decodeSyncQueueRow,
  type SyncQueueEntry,
  type SyncQueueOperationType,
  type SyncQueueRawRow,
} from '../types';

/**
 * The local `sync_queue` repository. Every method here operates on rows
 * shaped by `docs/sync-contract.md` §3.1 and never talks to the network —
 * pushing is P2.S2b's sync worker's job. This module only owns what goes
 * in the queue, what comes out of it, and what happens to a row once a
 * push response names it.
 */

export interface NewQueueEntry {
  /** Minted once, at enqueue, by the caller — never by this function (§1, §9.7: "an operation id is minted once at enqueue"; minting it here instead of at the call site would make every retry path re-derive whether it already has one, which is exactly the mistake §9.7 exists to prevent). */
  readonly operationId: string;
  readonly entityType: 'Observation';
  readonly entityId: string;
  readonly operationType: SyncQueueOperationType;
  readonly clientTimestamp: string;
}

/**
 * Appends one operation to the queue. Called only from
 * `../offlineWrites.ts`, inside the same transaction as the entity write
 * it accompanies — never standalone from a screen, or the two could commit
 * independently and leave an entity row with no queued operation to sync
 * it (or vice versa).
 */
export async function enqueueOperation(
  executor: SqliteExecutor,
  entry: NewQueueEntry,
  enqueuedAt: string,
): Promise<void> {
  await executor.runAsync(
    `INSERT INTO sync_queue (
      operation_id, entity_type, entity_id, operation_type,
      client_timestamp, enqueued_at, status, attempt_count,
      last_attempted_at, rejected_reason_code, rejected_field, rejected_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, NULL, NULL, NULL, NULL);`,
    [
      entry.operationId,
      entry.entityType,
      entry.entityId,
      entry.operationType,
      entry.clientTimestamp,
      enqueuedAt,
    ],
  );
}

/**
 * Every row awaiting a push attempt, in enqueue (FIFO) order — see
 * `../types.ts`'s `SyncQueueEntry.localSeq` doc comment for why this
 * ordinal, rather than `clientTimestamp` or `operationId`, is the
 * ordering key. Excludes `'rejected'` rows: a rejected operation is
 * retained (§3.5, §9.1) but never resubmitted unchanged (§9.2), so it must
 * never reappear in what the push loop reads.
 *
 * This does **not** implement `docs/sync-contract.md` §3.2's
 * clock-correction-discontinuity split — see `apps/mobile/README.md`
 * "Architecture notes for the next sprint" for why that is P2.S2b's
 * obligation and not this function's.
 */
export async function listQueuedOperations(
  executor: SqliteExecutor,
  limit?: number,
): Promise<SyncQueueEntry[]> {
  const rows =
    limit === undefined
      ? await executor.getAllAsync<SyncQueueRawRow>(
          "SELECT * FROM sync_queue WHERE status = 'queued' ORDER BY local_seq ASC;",
        )
      : await executor.getAllAsync<SyncQueueRawRow>(
          "SELECT * FROM sync_queue WHERE status = 'queued' ORDER BY local_seq ASC LIMIT ?;",
          [limit],
        );
  return rows.map(decodeSyncQueueRow);
}

export async function listRejectedOperations(executor: SqliteExecutor): Promise<SyncQueueEntry[]> {
  const rows = await executor.getAllAsync<SyncQueueRawRow>(
    "SELECT * FROM sync_queue WHERE status = 'rejected' ORDER BY local_seq ASC;",
  );
  return rows.map(decodeSyncQueueRow);
}

/** `docs/sync-contract.md` §3.5: `accepted` and `superseded` are both "remove from the queue. Not [necessarily] an error; nothing to correct." */
export async function removeOperation(
  executor: SqliteExecutor,
  operationId: string,
): Promise<void> {
  await executor.runAsync('DELETE FROM sync_queue WHERE operation_id = ?;', [operationId]);
}

/**
 * §3.5 / §9.1: a rejected operation is **retained locally and surfaced for
 * correction — never dropped**. This updates the row's status in place
 * rather than deleting and re-inserting, so `localSeq` (and therefore the
 * row's position relative to whatever was queued around it) survives.
 */
export async function markRejected(
  executor: SqliteExecutor,
  operationId: string,
  rejection: { reasonCode: string; field: string | null; rejectedAt: string },
): Promise<void> {
  await executor.runAsync(
    `UPDATE sync_queue SET
      status = 'rejected', rejected_reason_code = ?, rejected_field = ?, rejected_at = ?
    WHERE operation_id = ?;`,
    [rejection.reasonCode, rejection.field, rejection.rejectedAt, operationId],
  );
}

/**
 * Parks an operation that a §6.1 protocol error isolated down to on its own.
 *
 * ## Why this reuses the `rejected` status rather than adding a fourth
 *
 * A protocol error is a client bug, not something a patient got wrong, and
 * `docs/sync-contract.md` keeps the two vocabularies deliberately disjoint
 * (`SyncProtocolErrorCode` vs. `SyncReasonCode`) so neither can be returned
 * where the other belongs. Storing one in `rejected_reason_code` crosses
 * that line, and it is worth being explicit about why it is still right.
 *
 * §6.4 already defines what a client does with a code it cannot render to a
 * patient: show the generic "this entry could not be saved — please check
 * it" and keep the code for diagnostics. It requires the same of an
 * *unrecognized* code, because new codes are additive (§8). A protocol code
 * has no patient-facing copy by construction, so it lands in that bucket
 * without the inbox needing to know it is from the other vocabulary — the
 * renderer's existing "no copy for this code" branch is already correct for
 * it.
 *
 * What the status must convey to the queue is the part that matters: this
 * operation is retained, is not eligible for an unchanged retry (§9.2), and
 * needs the patient's attention. That is exactly `rejected`, and a fourth
 * status would duplicate all three properties to record a provenance
 * nothing downstream branches on.
 *
 * `rejected_field` is left NULL, which is the honest encoding: §6.1 bodies
 * carry no field path at all, and inventing one would be the echoed
 * diagnostic that section forbids.
 */
export async function markQuarantined(
  executor: SqliteExecutor,
  operationId: string,
  protocolErrorCode: string,
  quarantinedAt: string,
): Promise<void> {
  await executor.runAsync(
    `UPDATE sync_queue SET
      status = 'rejected', rejected_reason_code = ?, rejected_field = NULL, rejected_at = ?
    WHERE operation_id = ?;`,
    [protocolErrorCode, quarantinedAt, operationId],
  );
}

/**
 * Records a push attempt without changing the row's terminal fate — used
 * by the sync worker (P2.S2b) to mark a batch "in flight" before sending
 * it, so a crash mid-request leaves an honest `attemptCount` rather than
 * silently retrying with no record anything was ever tried. Not
 * exercised by any caller in this sprint; included so that bookkeeping
 * has somewhere to live without a schema change once the worker exists.
 */
export async function recordAttempt(
  executor: SqliteExecutor,
  operationId: string,
  attemptedAt: string,
): Promise<void> {
  await executor.runAsync(
    `UPDATE sync_queue SET
      status = 'in_flight', attempt_count = attempt_count + 1, last_attempted_at = ?
    WHERE operation_id = ?;`,
    [attemptedAt, operationId],
  );
}

/** Reverts an `'in_flight'` row back to `'queued'` — used when a push attempt fails with a network error or a `5xx` (`docs/sync-contract.md` §9.3: "treat a 5xx or a network failure as a rejection [is forbidden]; the operation's fate is unknown; re-push it"). Not exercised by any caller in this sprint. */
export async function revertToQueued(executor: SqliteExecutor, operationId: string): Promise<void> {
  await executor.runAsync("UPDATE sync_queue SET status = 'queued' WHERE operation_id = ?;", [
    operationId,
  ]);
}

export async function countByStatus(
  executor: SqliteExecutor,
): Promise<{ queued: number; inFlight: number; rejected: number }> {
  const rows = await executor.getAllAsync<{ status: string; count: number }>(
    'SELECT status, COUNT(*) as count FROM sync_queue GROUP BY status;',
  );
  const counts = { queued: 0, inFlight: 0, rejected: 0 };
  for (const row of rows) {
    if (row.status === 'queued') counts.queued = row.count;
    else if (row.status === 'in_flight') counts.inFlight = row.count;
    else if (row.status === 'rejected') counts.rejected = row.count;
  }
  return counts;
}
