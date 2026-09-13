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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runMigrations } from '../migrations';
import type { SqliteExecutor } from '../executor';
import { createNodeSqliteExecutor } from '../../test-support/nodeSqliteExecutor';

import {
  countByStatus,
  enqueueOperation,
  listQueuedOperations,
  listRejectedOperations,
  recordAttempt,
  markRejected,
  removeOperation,
  revertToQueued,
} from './syncQueueRepository';

const FIXED_NOW = () => new Date('2026-09-11T22:04:11.412Z');

describe('syncQueueRepository', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-sync-queue-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns queued operations in enqueue (FIFO) order, regardless of clientTimestamp values', async () => {
    await enqueueOperation(
      executor,
      {
        operationId: 'op-1',
        entityType: 'Observation',
        entityId: 'entity-1',
        operationType: 'create',
        clientTimestamp: '2026-09-11T22:00:00.000Z',
      },
      '2026-09-11T22:00:00.000Z',
    );
    await enqueueOperation(
      executor,
      {
        operationId: 'op-2',
        entityType: 'Observation',
        entityId: 'entity-2',
        operationType: 'create',
        clientTimestamp: '2026-09-11T21:00:00.000Z', // earlier clientTimestamp, enqueued second
      },
      '2026-09-11T22:01:00.000Z',
    );

    const queued = await listQueuedOperations(executor);
    expect(queued.map((op) => op.operationId)).toEqual(['op-1', 'op-2']);
  });

  it('honours a limit', async () => {
    for (let i = 0; i < 3; i += 1) {
      await enqueueOperation(
        executor,
        {
          operationId: `op-${i}`,
          entityType: 'Observation',
          entityId: `entity-${i}`,
          operationType: 'create',
          clientTimestamp: '2026-09-11T22:00:00.000Z',
        },
        '2026-09-11T22:00:00.000Z',
      );
    }

    const queued = await listQueuedOperations(executor, 2);
    expect(queued).toHaveLength(2);
  });

  describe('AC 13.1 AC4 — Rejected Sync Operations Are Not Lost', () => {
    it('a rejected operation is retained (not deleted) and excluded from what the push loop reads next', async () => {
      await enqueueOperation(
        executor,
        {
          operationId: 'op-rejected',
          entityType: 'Observation',
          entityId: 'entity-1',
          operationType: 'create',
          clientTimestamp: '2026-09-11T22:00:00.000Z',
        },
        '2026-09-11T22:00:00.000Z',
      );

      await markRejected(executor, 'op-rejected', {
        reasonCode: 'VALUE_EXCEEDS_MAX_MAGNITUDE',
        field: 'valueQuantity.value',
        rejectedAt: '2026-09-11T22:10:00.000Z',
      });

      expect(await listQueuedOperations(executor)).toHaveLength(0);

      const rejected = await listRejectedOperations(executor);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        operationId: 'op-rejected',
        status: 'rejected',
        rejectedReasonCode: 'VALUE_EXCEEDS_MAX_MAGNITUDE',
        rejectedField: 'valueQuantity.value',
      });
    });

    it('never carries the offending clinical value — only a reason code and a field path (§6.3)', async () => {
      await enqueueOperation(
        executor,
        {
          operationId: 'op-rejected-2',
          entityType: 'Observation',
          entityId: 'entity-2',
          operationType: 'create',
          clientTimestamp: '2026-09-11T22:00:00.000Z',
        },
        '2026-09-11T22:00:00.000Z',
      );

      const before = (await listQueuedOperations(executor)).find(
        (op) => op.operationId === 'op-rejected-2',
      );

      await markRejected(executor, 'op-rejected-2', {
        reasonCode: 'VALUE_NOT_POSITIVE',
        field: 'valueQuantity.value',
        rejectedAt: '2026-09-11T22:10:00.000Z',
      });

      const [rejection] = await listRejectedOperations(executor);
      // Asserts what markRejected WROTE, not what the decoder's fixed key
      // list happens to contain.
      //
      // The previous assertion — `Object.keys(rejection).not.toContain('value')`
      // — was vacuous: `decodeSyncQueueRow` builds its object from a literal
      // key set, so 'value' could never appear no matter what markRejected
      // did. It would have passed with a clinical value written into any
      // existing column.
      const changed = Object.entries(rejection as unknown as Record<string, unknown>).filter(
        ([key, value]) => (before as unknown as Record<string, unknown>)[key] !== value,
      );
      expect(changed.map(([key]) => key).sort()).toEqual(
        ['rejectedAt', 'rejectedField', 'rejectedReasonCode', 'status'].sort(),
      );
      expect(rejection!.rejectedReasonCode).toBe('VALUE_NOT_POSITIVE');
    });
  });

  it('accepted/superseded operations are removed from the queue entirely (§3.5)', async () => {
    await enqueueOperation(
      executor,
      {
        operationId: 'op-accepted',
        entityType: 'Observation',
        entityId: 'entity-1',
        operationType: 'create',
        clientTimestamp: '2026-09-11T22:00:00.000Z',
      },
      '2026-09-11T22:00:00.000Z',
    );

    await removeOperation(executor, 'op-accepted');

    expect(await listQueuedOperations(executor)).toHaveLength(0);
    expect(await listRejectedOperations(executor)).toHaveLength(0);
  });

  describe('the in-flight round trip — the CHECK constraint has a witness', () => {
    /**
     * `recordAttempt` and `revertToQueued` have no caller until the sync
     * worker lands, so nothing exercised the status values they write.
     *
     * That gap let migration 2 recreate `sync_queue` with
     * `CHECK (status IN ('queued', 'inFlight', 'rejected'))` — the
     * TypeScript-side camelCase name, not the value the SQL actually
     * stores. Every push would have thrown before its network call, and a
     * device already holding an `in_flight` row would have failed the
     * migration on every launch and never opened its database again. The
     * whole suite stayed green.
     */
    async function enqueueOne(operationId: string): Promise<void> {
      await enqueueOperation(
        executor,
        {
          operationId,
          entityType: 'Observation',
          entityId: `entity-${operationId}`,
          operationType: 'create',
          clientTimestamp: '2026-09-11T22:00:00.000Z',
        },
        '2026-09-11T22:00:01.000Z',
      );
    }

    it('marks an operation in flight without violating the status constraint', async () => {
      await enqueueOne('op-flight');

      await expect(
        recordAttempt(executor, 'op-flight', '2026-09-11T22:05:00.000Z'),
      ).resolves.toBeUndefined();

      const counts = await countByStatus(executor);
      expect(counts).toEqual({ queued: 0, inFlight: 1, rejected: 0 });
    });

    it('removes an in-flight operation from the queued list, so a push cannot double-send it', async () => {
      await enqueueOne('op-flight');
      await recordAttempt(executor, 'op-flight', '2026-09-11T22:05:00.000Z');

      const queued = await listQueuedOperations(executor);
      expect(queued.map((op) => op.operationId)).not.toContain('op-flight');
    });

    it('reverts to queued on an unknown outcome (§9.3: a 5xx or network failure is never a rejection)', async () => {
      await enqueueOne('op-flight');
      await recordAttempt(executor, 'op-flight', '2026-09-11T22:05:00.000Z');

      await expect(revertToQueued(executor, 'op-flight')).resolves.toBeUndefined();

      const counts = await countByStatus(executor);
      expect(counts).toEqual({ queued: 1, inFlight: 0, rejected: 0 });
    });

    it('preserves local_seq across the round trip, because a push is ordered by it', async () => {
      await enqueueOne('op-a');
      await enqueueOne('op-b');
      const before = (await listQueuedOperations(executor)).map((op) => op.operationId);

      await recordAttempt(executor, 'op-a', '2026-09-11T22:05:00.000Z');
      await revertToQueued(executor, 'op-a');

      const after = (await listQueuedOperations(executor)).map((op) => op.operationId);
      expect(after).toEqual(before);
    });
  });
});
