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

import type { SyncQueueEntry } from '../db/types';

/**
 * Splitting the local queue into pushable batches — `docs/sync-contract.md`
 * §3.2 and §3.3, the one obligation `apps/mobile/README.md` explicitly
 * hands to this sprint rather than to the queue repository.
 *
 * Pure: it takes rows and returns rows in groups. It reads no clock, opens
 * no database and sends nothing. Every rule below is a property a reviewer
 * can check against the contract by reading the tests alone, which is why
 * the splitting lives here and not inline in the push loop.
 *
 * ## Why a client has to split at all
 *
 * §3.2 requires each request's operations to be **non-descending** in
 * `clientTimestamp`, and a descending array is a protocol error that fails
 * the whole request — the server is forbidden from reordering, because
 * last-write-wins is defined by that timestamp and reordering would
 * silently change which version wins.
 *
 * But a descending local queue is **not** a client bug. A patient
 * correcting their phone's clock, or an NTP correction after a cold boot,
 * produces a queue that is locally correct and descending across the
 * discontinuity. §3.2 spells out the consequence: without splitting, the
 * ordering rule, §9.6's ban on reordering, and §6.1's ban on retrying a
 * `400` unchanged are jointly unsatisfiable, and a patient's entire offline
 * backlog is stuck behind a clock correction they cannot undo.
 *
 * So the obligation is not "never be descending" but **split at each
 * discontinuity and push the runs in order**.
 *
 * ## What this function must never do
 *
 * It never reorders (§9.6) and never coalesces (§9.6 again — two edits to
 * one entity are two operations, and merging them destroys the intermediate
 * version the audit log is entitled to). Order is preserved within every
 * batch and across every split: concatenating the output in order
 * reproduces the input exactly. `preservesOrderExactly` in the spec asserts
 * that as a property rather than trusting the implementation to be read
 * correctly.
 */

/**
 * The maximum operations per request is **server** configuration
 * (`SYNC_PUSH_MAX_OPERATIONS`, §3.3), not a constant this app is entitled
 * to know. It is a required argument rather than a default here for the
 * same reason `packages/core/src/sync` has no thresholds in it at all: a
 * default in client code is a second source of truth that silently stops
 * matching the server the day an operator changes it, and the failure is a
 * `413` the client cannot explain.
 *
 * The caller passes what it is configured with; a `413` at push time is
 * what tells it the value is wrong (§3.3: "the client splits the batch,
 * preserving order across the split").
 */
export interface BatchingOptions {
  readonly maxOperationsPerBatch: number;
}

/**
 * Groups queued operations into batches that each satisfy §3.2 and §3.3.
 *
 * Input MUST already be in queue (FIFO `localSeq`) order — that is what
 * `listQueuedOperations` returns, and it is the only order this app is
 * allowed to push in.
 */
export function splitIntoPushBatches(
  operations: readonly SyncQueueEntry[],
  options: BatchingOptions,
): SyncQueueEntry[][] {
  if (options.maxOperationsPerBatch < 1) {
    throw new RangeError(
      `maxOperationsPerBatch must be at least 1; received ${String(options.maxOperationsPerBatch)}. A batch size of zero would produce no batches and silently stall the queue forever.`,
    );
  }

  const batches: SyncQueueEntry[][] = [];
  let current: SyncQueueEntry[] = [];

  for (const operation of operations) {
    const previous = current[current.length - 1];
    const startsNewRun = previous !== undefined && isDescending(previous, operation);
    const isFull = current.length >= options.maxOperationsPerBatch;

    if (current.length > 0 && (startsNewRun || isFull)) {
      batches.push(current);
      current = [];
    }
    current.push(operation);
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * String comparison, deliberately, not `Date` parsing.
 *
 * Every `clientTimestamp` in this queue was written by `toWireInstant`, so
 * it is RFC 3339, UTC, with exactly three fractional digits (§7.3) — a
 * fixed-width form whose lexical order **is** its chronological order.
 * Parsing to `Date` and comparing epoch milliseconds would agree on every
 * value this app can produce, and would additionally paper over a
 * malformed one by coercing it to `NaN`, where every comparison is `false`
 * and the discontinuity silently fails to be detected.
 *
 * Lexical comparison has no `NaN` state: a malformed timestamp compares as
 * a string and still splits the batch, which is the safe direction — an
 * unnecessary split costs one extra request, while a missed one costs the
 * whole backlog a `400` it is forbidden to retry unchanged.
 */
function isDescending(previous: SyncQueueEntry, next: SyncQueueEntry): boolean {
  return next.clientTimestamp < previous.clientTimestamp;
}
