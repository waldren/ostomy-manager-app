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
  enqueueOperation,
  listQueuedOperations,
  listRejectedOperations,
  markRejected,
  removeOperation,
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
});
