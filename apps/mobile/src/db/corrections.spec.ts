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

import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import type { SqliteExecutor } from './executor';
import { runMigrations } from './migrations';
import {
  discardRejectedCreate,
  enqueueVolumetricObservationCreate,
  reenqueueCorrectedObservation,
} from './offlineWrites';
import { getObservationById } from './repositories/observationsRepository';
import {
  listQueuedOperations,
  listRejectedOperations,
  markRejected,
} from './repositories/syncQueueRepository';
import { countUnsyncedEntries } from './unsyncedCount';

const STOMA_OUTPUT_CODE = '79560-9';
const FIXED_NOW = () => new Date('2026-09-16T12:00:00.000Z');
const LATER = () => new Date('2026-09-16T13:00:00.000Z');

describe('the correction inbox write path', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-corrections-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  async function rejectedEntry() {
    const { id } = await enqueueVolumetricObservationCreate(
      executor,
      {
        code: STOMA_OUTPUT_CODE,
        valueQuantityValue: '350',
        valueQuantityUnit: 'mL',
        effectiveDatetime: '2026-09-16T11:00:00.000Z',
        measuredOrEstimated: 'measured',
        enteredMeasurementSystem: 'metric',
      },
      FIXED_NOW,
    );
    const operation = (await listQueuedOperations(executor))[0]!;
    await markRejected(executor, operation.operationId, {
      reasonCode: 'VALUE_NOT_POSITIVE',
      field: 'valueQuantity.value',
      rejectedAt: '2026-09-16T12:30:00.000Z',
    });
    return { id, operationId: operation.operationId };
  }

  describe('reenqueueCorrectedObservation', () => {
    /** §9.7: an operation id is minted once, and reusing one is the only thing standing between a retry and a duplicate row. */
    it('mints a new operation id rather than reusing the rejected one', async () => {
      const { id, operationId } = await rejectedEntry();

      const { operationId: corrected } = await reenqueueCorrectedObservation(
        executor,
        {
          id,
          rejectedOperationId: operationId,
          rejectedOperationType: 'create',
          code: STOMA_OUTPUT_CODE,
          valueQuantityValue: '425',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-16T11:00:00.000Z',
          measuredOrEstimated: 'measured',
          enteredMeasurementSystem: 'metric',
        },
        LATER,
      );

      expect(corrected).not.toBe(operationId);
      const queued = await listQueuedOperations(executor);
      expect(queued.map((operation) => operation.operationId)).toEqual([corrected]);
    });

    /** §9.2: the rejected operation must not remain eligible for an unchanged retry. */
    it('removes the rejected operation, so the inbox empties', async () => {
      const { id, operationId } = await rejectedEntry();

      await reenqueueCorrectedObservation(
        executor,
        {
          id,
          rejectedOperationId: operationId,
          rejectedOperationType: 'create',
          code: STOMA_OUTPUT_CODE,
          valueQuantityValue: '425',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-16T11:00:00.000Z',
          measuredOrEstimated: 'measured',
          enteredMeasurementSystem: 'metric',
        },
        LATER,
      );

      expect(await listRejectedOperations(executor)).toHaveLength(0);
    });

    it('writes the corrected value to the entity row', async () => {
      const { id, operationId } = await rejectedEntry();

      await reenqueueCorrectedObservation(
        executor,
        {
          id,
          rejectedOperationId: operationId,
          rejectedOperationType: 'create',
          code: STOMA_OUTPUT_CODE,
          valueQuantityValue: '425',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-16T11:00:00.000Z',
          measuredOrEstimated: 'measured',
          enteredMeasurementSystem: 'metric',
        },
        LATER,
      );

      expect((await getObservationById(executor, id))?.valueQuantityValue).toBe('425');
    });

    /**
     * A rejected create must go back as a create. The server refused the
     * original, so no row of this entity exists there — and an update naming
     * an id the server has never seen is `ENTITY_NOT_FOUND` (§6.2), which
     * puts the entry straight back in the inbox carrying a code the patient
     * can do nothing about.
     */
    it('preserves the operation type of the rejected operation', async () => {
      const { id, operationId } = await rejectedEntry();

      await reenqueueCorrectedObservation(
        executor,
        {
          id,
          rejectedOperationId: operationId,
          rejectedOperationType: 'create',
          code: STOMA_OUTPUT_CODE,
          valueQuantityValue: '425',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-16T11:00:00.000Z',
          measuredOrEstimated: 'measured',
          enteredMeasurementSystem: 'metric',
        },
        LATER,
      );

      expect((await listQueuedOperations(executor))[0]?.operationType).toBe('create');
    });

    /** §3.8's recipe: a corrected write carries the CURRENT clock, which may make it win a conflict the original would have lost. That is the intended trade. */
    it('carries a fresh client timestamp rather than the rejected one', async () => {
      const { id, operationId } = await rejectedEntry();

      await reenqueueCorrectedObservation(
        executor,
        {
          id,
          rejectedOperationId: operationId,
          rejectedOperationType: 'create',
          code: STOMA_OUTPUT_CODE,
          valueQuantityValue: '425',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-16T11:00:00.000Z',
          measuredOrEstimated: 'measured',
          enteredMeasurementSystem: 'metric',
        },
        LATER,
      );

      expect((await listQueuedOperations(executor))[0]?.clientTimestamp).toBe(
        LATER().toISOString(),
      );
    });
  });

  describe('discardRejectedCreate', () => {
    /**
     * §9.1 bans the CLIENT dropping a rejected operation silently. A patient
     * deliberately discarding their own entry is the opposite — they are the
     * one actor entitled to make that call.
     */
    it('removes the rejected operation and tombstones the local row', async () => {
      const { id, operationId } = await rejectedEntry();

      await discardRejectedCreate(executor, { id, rejectedOperationId: operationId }, LATER);

      expect(await listRejectedOperations(executor)).toHaveLength(0);
      // §1: deletes never remove rows.
      const row = await getObservationById(executor, id);
      expect(row).toBeDefined();
      expect(row?.deletedAt).not.toBeNull();
    });

    /** No delete is queued: the rejected operation was the only thing that ever named this entity to the server, and it was refused. */
    it('queues no operation, because the server has no row to tombstone', async () => {
      const { id, operationId } = await rejectedEntry();

      await discardRejectedCreate(executor, { id, rejectedOperationId: operationId }, LATER);

      expect(await listQueuedOperations(executor)).toHaveLength(0);
    });
  });

  describe('countUnsyncedEntries', () => {
    /**
     * The sign-out warning is built on this. Counting only `queued` would
     * tell a patient with a full correction inbox that everything had been
     * sent — and sign-out then destroys those entries with certainty.
     */
    it('counts a rejected entry as unsynced', async () => {
      await rejectedEntry();

      expect(await countUnsyncedEntries(executor)).toBe(1);
    });

    it('counts a queued entry as unsynced', async () => {
      await enqueueVolumetricObservationCreate(
        executor,
        {
          code: STOMA_OUTPUT_CODE,
          valueQuantityValue: '100',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-16T11:00:00.000Z',
          measuredOrEstimated: 'measured',
          enteredMeasurementSystem: 'metric',
        },
        FIXED_NOW,
      );

      expect(await countUnsyncedEntries(executor)).toBe(1);
    });

    it('reports zero once nothing is left in the queue', async () => {
      expect(await countUnsyncedEntries(executor)).toBe(0);
    });
  });
});
