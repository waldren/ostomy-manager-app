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

import { splitIntoPushBatches } from './batching';

function entry(localSeq: number, clientTimestamp: string): SyncQueueEntry {
  return {
    localSeq,
    operationId: `op-${String(localSeq)}`,
    entityType: 'Observation',
    entityId: `entity-${String(localSeq)}`,
    operationType: 'create',
    clientTimestamp,
    enqueuedAt: clientTimestamp,
    status: 'queued',
    attemptCount: 0,
    lastAttemptedAt: null,
    rejectedReasonCode: null,
    rejectedField: null,
    rejectedAt: null,
  };
}

/** Every batch a correct client sends must satisfy this, or §6.1 fails the whole request. */
function isNonDescending(batch: readonly SyncQueueEntry[]): boolean {
  return batch.every(
    (operation, index) =>
      index === 0 || operation.clientTimestamp >= batch[index - 1]!.clientTimestamp,
  );
}

describe('splitIntoPushBatches', () => {
  it('keeps an already-ascending queue in one batch', () => {
    const queue = [
      entry(1, '2026-09-15T10:00:00.000Z'),
      entry(2, '2026-09-15T10:05:00.000Z'),
      entry(3, '2026-09-15T10:09:00.000Z'),
    ];

    const batches = splitIntoPushBatches(queue, { maxOperationsPerBatch: 500 });

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(3);
  });

  it('permits equal timestamps within one batch (§3.2: resolved by array order)', () => {
    const shared = '2026-09-15T10:00:00.000Z';
    const queue = [entry(1, shared), entry(2, shared), entry(3, shared)];

    const batches = splitIntoPushBatches(queue, { maxOperationsPerBatch: 500 });

    expect(batches).toHaveLength(1);
    expect(batches[0]!.map((operation) => operation.localSeq)).toEqual([1, 2, 3]);
  });

  /**
   * The case §3.2 exists for: a patient corrects the phone's clock, or NTP
   * does it after a cold boot. The queue is locally correct and descending
   * across the discontinuity, and without a split the entire offline backlog
   * is stuck behind a `400` the client is forbidden to retry unchanged.
   */
  it('splits at a backwards clock correction, and every batch is non-descending', () => {
    const queue = [
      entry(1, '2026-09-15T10:00:00.000Z'),
      entry(2, '2026-09-15T10:05:00.000Z'),
      // The clock moves back an hour here.
      entry(3, '2026-09-15T09:10:00.000Z'),
      entry(4, '2026-09-15T09:15:00.000Z'),
    ];

    const batches = splitIntoPushBatches(queue, { maxOperationsPerBatch: 500 });

    expect(batches).toHaveLength(2);
    expect(batches[0]!.map((operation) => operation.localSeq)).toEqual([1, 2]);
    expect(batches[1]!.map((operation) => operation.localSeq)).toEqual([3, 4]);
    expect(batches.every(isNonDescending)).toBe(true);
  });

  it('splits at every discontinuity when a clock moves back repeatedly', () => {
    const queue = [
      entry(1, '2026-09-15T12:00:00.000Z'),
      entry(2, '2026-09-15T11:00:00.000Z'),
      entry(3, '2026-09-15T10:00:00.000Z'),
      entry(4, '2026-09-15T10:30:00.000Z'),
    ];

    const batches = splitIntoPushBatches(queue, { maxOperationsPerBatch: 500 });

    expect(batches.map((batch) => batch.map((operation) => operation.localSeq))).toEqual([
      [1],
      [2],
      [3, 4],
    ]);
    expect(batches.every(isNonDescending)).toBe(true);
  });

  it('splits at the configured size bound (§3.3)', () => {
    const queue = Array.from({ length: 7 }, (_, index) =>
      entry(index + 1, `2026-09-15T10:0${String(index)}:00.000Z`),
    );

    const batches = splitIntoPushBatches(queue, { maxOperationsPerBatch: 3 });

    expect(batches.map((batch) => batch.length)).toEqual([3, 3, 1]);
    expect(batches.every(isNonDescending)).toBe(true);
  });

  it('applies both rules at once without losing or reordering an operation', () => {
    const queue = [
      entry(1, '2026-09-15T10:00:00.000Z'),
      entry(2, '2026-09-15T10:01:00.000Z'),
      entry(3, '2026-09-15T10:02:00.000Z'),
      entry(4, '2026-09-15T09:00:00.000Z'),
      entry(5, '2026-09-15T09:01:00.000Z'),
    ];

    const batches = splitIntoPushBatches(queue, { maxOperationsPerBatch: 2 });

    expect(batches.map((batch) => batch.map((operation) => operation.localSeq))).toEqual([
      [1, 2],
      [3],
      [4, 5],
    ]);
    expect(batches.every(isNonDescending)).toBe(true);
  });

  /**
   * §9.6: never reorder, never coalesce. Asserted as a property over the
   * whole output rather than trusted to be visible by reading the
   * implementation — concatenating the batches in order must reproduce the
   * input exactly, which forbids dropping, duplicating, merging and
   * resequencing in a single check.
   */
  it('preserves order exactly: concatenating the batches reproduces the input', () => {
    const queue = [
      entry(1, '2026-09-15T10:00:00.000Z'),
      entry(2, '2026-09-15T08:00:00.000Z'),
      entry(3, '2026-09-15T08:00:00.000Z'),
      entry(4, '2026-09-15T23:59:59.999Z'),
      entry(5, '2026-09-15T00:00:00.000Z'),
      entry(6, '2026-09-15T00:00:00.001Z'),
    ];

    const batches = splitIntoPushBatches(queue, { maxOperationsPerBatch: 2 });

    expect(batches.flat()).toEqual(queue);
  });

  it('returns no batches for an empty queue rather than one empty batch', () => {
    expect(splitIntoPushBatches([], { maxOperationsPerBatch: 500 })).toEqual([]);
  });

  /**
   * A batch size of zero produces no batches from a non-empty queue, which
   * stalls every entry the patient has made with no error anywhere. Loud at
   * the boundary beats silent forever.
   */
  it('refuses a batch size below one instead of silently stalling the queue', () => {
    expect(() =>
      splitIntoPushBatches([entry(1, '2026-09-15T10:00:00.000Z')], { maxOperationsPerBatch: 0 }),
    ).toThrow(RangeError);
  });

  /**
   * A malformed timestamp must not defeat discontinuity detection. Parsing
   * to `Date` yields `NaN`, where every comparison is `false` and the split
   * silently does not happen; lexical comparison has no such state, and an
   * unnecessary split costs one request while a missed one costs the whole
   * backlog.
   */
  it('still splits when a timestamp is malformed rather than comparing as NaN', () => {
    const queue = [
      entry(1, '2026-09-15T10:00:00.000Z'),
      entry(2, 'not-a-timestamp'),
      entry(3, '2026-09-15T10:01:00.000Z'),
    ];

    const batches = splitIntoPushBatches(queue, { maxOperationsPerBatch: 500 });

    expect(batches.flat()).toEqual(queue);
    expect(batches.length).toBeGreaterThan(1);
  });
});
