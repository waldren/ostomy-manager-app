/*
Copyright (C) 2026 Steven E. Waldren

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SqliteExecutor } from './executor';
import { runMigrations } from './migrations';
import { enqueueMealCreate, enqueueVolumetricObservationCreate } from './offlineWrites';
import { getMealById } from './repositories/mealsRepository';
import { getObservationById } from './repositories/observationsRepository';
import { getCursor, setCursor } from './repositories/syncCursorRepository';
import { listQueuedOperations, removeOperation } from './repositories/syncQueueRepository';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { recoverFromStaleCursor } from './staleCursorRecovery';

const FIXED_NOW = () => new Date('2026-09-18T12:00:00.000Z');
const STOMA_OUTPUT_CODE = '79560-9';

const draft = {
  code: STOMA_OUTPUT_CODE,
  valueQuantityValue: '350',
  valueQuantityUnit: 'mL',
  effectiveDatetime: '2026-09-18T11:00:00.000Z',
  measuredOrEstimated: 'measured',
  enteredMeasurementSystem: 'metric',
  fluidTypeCode: null,
} as const;

describe('recoverFromStaleCursor (sync-contract §5.4)', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-stale-cursor-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Drains the queue the way a successful push would, leaving a server-derived row behind. */
  async function settle(): Promise<void> {
    for (const operation of await listQueuedOperations(executor)) {
      await removeOperation(executor, operation.operationId);
    }
  }

  it('resets the cursor to 0, so the next cycle re-pulls from scratch', async () => {
    await setCursor(executor, '4821', FIXED_NOW().toISOString());

    await recoverFromStaleCursor(executor, FIXED_NOW);

    expect(await getCursor(executor)).toBe('0');
  });

  it('discards a server-derived row, because a re-pull will bring it back or prove it gone', async () => {
    const { id } = await enqueueVolumetricObservationCreate(executor, draft, FIXED_NOW);
    await settle();

    const outcome = await recoverFromStaleCursor(executor, FIXED_NOW);

    expect(await getObservationById(executor, id)).toBeUndefined();
    expect(outcome.discardedObservations).toBe(1);
  });

  /**
   * The row §5.4 exists to remove: deleted by the patient on another device,
   * its tombstone since purged, so no delta page will ever mention it again.
   * Only a wipe-and-re-pull clears it.
   */
  it('discards a row the server will never mention again', async () => {
    const { id } = await enqueueVolumetricObservationCreate(executor, draft, FIXED_NOW);
    await settle();

    await recoverFromStaleCursor(executor, FIXED_NOW);

    expect(await getObservationById(executor, id)).toBeUndefined();
  });

  describe('unsent local work survives', () => {
    /**
     * §9.1 forbids dropping a queued operation, and §9.5 makes it worse: the
     * patient was already told this entry was saved. A re-sync from zero
     * cannot bring it back, because the server has never seen it.
     */
    it('keeps an observation whose create has not pushed yet', async () => {
      const { id } = await enqueueVolumetricObservationCreate(executor, draft, FIXED_NOW);

      const outcome = await recoverFromStaleCursor(executor, FIXED_NOW);

      expect(await getObservationById(executor, id)).toBeDefined();
      expect(outcome).toMatchObject({ discardedObservations: 0, keptPendingObservations: 1 });
    });

    it('keeps a meal whose create has not pushed yet', async () => {
      const { id } = await enqueueMealCreate(
        executor,
        {
          description: 'Porridge',
          size: 'medium',
          tagCodes: [],
          effectiveDatetime: '2026-09-18T11:00:00.000Z',
        },
        FIXED_NOW,
      );

      const outcome = await recoverFromStaleCursor(executor, FIXED_NOW);

      expect(await getMealById(executor, id)).toBeDefined();
      expect(outcome).toMatchObject({ discardedMeals: 0, keptPendingMeals: 1 });
    });

    it('leaves the queue itself completely untouched', async () => {
      await enqueueVolumetricObservationCreate(executor, draft, FIXED_NOW);
      await enqueueMealCreate(
        executor,
        {
          description: 'Soup',
          size: 'small',
          tagCodes: [],
          effectiveDatetime: '2026-09-18T11:00:00.000Z',
        },
        FIXED_NOW,
      );
      const before = await listQueuedOperations(executor);

      await recoverFromStaleCursor(executor, FIXED_NOW);

      expect(await listQueuedOperations(executor)).toEqual(before);
    });

    it('discards settled rows while keeping unsent ones, in the same pass', async () => {
      const settled = await enqueueVolumetricObservationCreate(executor, draft, FIXED_NOW);
      await settle();
      const unsent = await enqueueVolumetricObservationCreate(executor, draft, FIXED_NOW);

      const outcome = await recoverFromStaleCursor(executor, FIXED_NOW);

      expect(await getObservationById(executor, settled.id)).toBeUndefined();
      expect(await getObservationById(executor, unsent.id)).toBeDefined();
      expect(outcome).toMatchObject({ discardedObservations: 1, keptPendingObservations: 1 });
    });
  });

  it('is safe to run against an empty database', async () => {
    const outcome = await recoverFromStaleCursor(executor, FIXED_NOW);

    expect(outcome).toEqual({
      discardedObservations: 0,
      discardedMeals: 0,
      keptPendingObservations: 0,
      keptPendingMeals: 0,
    });
    expect(await getCursor(executor)).toBe('0');
  });

  it('is idempotent — running it twice changes nothing the second time', async () => {
    await enqueueVolumetricObservationCreate(executor, draft, FIXED_NOW);
    await settle();

    await recoverFromStaleCursor(executor, FIXED_NOW);
    const second = await recoverFromStaleCursor(executor, FIXED_NOW);

    expect(second).toMatchObject({ discardedObservations: 0, discardedMeals: 0 });
    expect(await getCursor(executor)).toBe('0');
  });
});
