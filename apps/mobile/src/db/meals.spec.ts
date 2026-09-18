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
  buildMealPayload,
  enqueueMealCreate,
  enqueueMealDelete,
  enqueueMealUpdate,
} from './offlineWrites';
import { getMealById } from './repositories/mealsRepository';
import { listQueuedOperations } from './repositories/syncQueueRepository';

const FIXED_NOW = () => new Date('2026-09-17T12:00:00.000Z');
const EATEN_AT = '2026-09-17T11:30:00.000Z';

describe('the local meal write path (SRS AC 2.4)', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-meals-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  function create(overrides: Partial<Parameters<typeof enqueueMealCreate>[1]> = {}) {
    return enqueueMealCreate(
      executor,
      {
        description: 'Porridge and a banana',
        size: 'medium',
        tagCodes: ['high_fibre'],
        effectiveDatetime: EATEN_AT,
        ...overrides,
      },
      FIXED_NOW,
    );
  }

  /**
   * SRS §4.5: the local write IS the save confirmation, which has no meaning
   * if the entity row and its queue entry can commit independently — a meal
   * with no queued operation never syncs, and a queued operation with no meal
   * cannot be built into a payload.
   */
  it('writes the meal and its queued operation together, atomically', async () => {
    const { id, operationId } = await create();

    expect(await getMealById(executor, id)).toBeDefined();
    const queued = await listQueuedOperations(executor);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ operationId, entityType: 'Meal', operationType: 'create' });
  });

  /** §1: "Never the entity id" — two separate mints, never one value reused. */
  it('mints an operation id distinct from the entity id', async () => {
    const { id, operationId } = await create();
    expect(operationId).not.toBe(id);
  });

  it('stores an optional description as null when there is none', async () => {
    const { id } = await create({ description: null });
    expect((await getMealById(executor, id))?.description).toBeNull();
  });

  it('round-trips tags through their JSON column', async () => {
    const { id } = await create({ tagCodes: ['dairy', 'spicy'] });
    expect((await getMealById(executor, id))?.tagCodes).toEqual(['dairy', 'spicy']);
  });

  it('stores no tags as an empty list rather than null', async () => {
    const { id } = await create({ tagCodes: [] });
    expect((await getMealById(executor, id))?.tagCodes).toEqual([]);
  });

  /**
   * ADR-0016: derived at write time from the device zone and the SAME shared
   * helper the server uses, so the phone and the server cannot group a day
   * differently.
   */
  it('derives localDate from the entry instant and the device zone', async () => {
    const { id } = await create();
    const meal = await getMealById(executor, id);

    expect(meal?.enteredTimezone).toBeTruthy();
    expect(meal?.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  describe('update and delete queue the shapes the wire contract requires', () => {
    it('an update replaces every field and queues an update operation (§4)', async () => {
      const { id } = await create();

      await enqueueMealUpdate(
        executor,
        {
          id,
          description: 'Soup',
          size: 'large',
          tagCodes: ['dairy'],
          effectiveDatetime: EATEN_AT,
        },
        FIXED_NOW,
      );

      const meal = await getMealById(executor, id);
      expect(meal).toMatchObject({ description: 'Soup', size: 'large', tagCodes: ['dairy'] });
      const queued = await listQueuedOperations(executor);
      expect(queued.map((operation) => operation.operationType)).toEqual(['create', 'update']);
    });

    /** §1: deletes never remove rows. The tombstone is what a second device learns from. */
    it('a delete tombstones the row in place rather than removing it', async () => {
      const { id } = await create();

      await enqueueMealDelete(executor, id, FIXED_NOW);

      const meal = await getMealById(executor, id);
      expect(meal).toBeDefined();
      expect(meal?.deletedAt).not.toBeNull();
    });

    /** §4: an update at T2 beats a delete at T1, resurrecting the row by clearing deletedAt. */
    it('an update after a delete resurrects the meal', async () => {
      const { id } = await create();
      await enqueueMealDelete(executor, id, FIXED_NOW);

      await enqueueMealUpdate(
        executor,
        {
          id,
          description: 'Soup',
          size: 'small',
          tagCodes: [],
          effectiveDatetime: EATEN_AT,
        },
        FIXED_NOW,
      );

      expect((await getMealById(executor, id))?.deletedAt).toBeNull();
    });
  });

  describe('the wire payload (§7.4)', () => {
    it('carries exactly the six fields the contract names', async () => {
      const { id } = await create();
      const meal = await getMealById(executor, id);

      const payload = JSON.parse(
        buildMealPayload({
          id: meal!.id,
          description: meal!.description,
          size: meal!.size,
          tagCodes: meal!.tagCodes,
          effectiveDatetime: meal!.effectiveDatetime,
          enteredTimezone: meal!.enteredTimezone,
        }),
      ) as Record<string, unknown>;

      expect(Object.keys(payload).sort()).toEqual([
        'description',
        'effectiveDateTime',
        'enteredTimezone',
        'id',
        'size',
        'tagCodes',
      ]);
    });

    /**
     * A meal is app-native; `resourceType` is FHIR's key, and carrying it
     * would assert a conformance to `NutritionIntake` this entity does not
     * have (§7.1, §7.4).
     */
    it('carries no resourceType, and none of this app’s local bookkeeping', async () => {
      const { id } = await create();
      const meal = await getMealById(executor, id);

      const payload = JSON.parse(
        buildMealPayload({
          id: meal!.id,
          description: meal!.description,
          size: meal!.size,
          tagCodes: meal!.tagCodes,
          effectiveDatetime: meal!.effectiveDatetime,
          enteredTimezone: meal!.enteredTimezone,
        }),
      ) as Record<string, unknown>;

      for (const forbidden of [
        'resourceType',
        'localDate',
        'serverSequence',
        'deletedAt',
        'createdAt',
        'updatedAt',
      ]) {
        expect(payload).not.toHaveProperty(forbidden);
      }
    });
  });

  it('survives closing and reopening the database, as an app restart would', async () => {
    const path = join(dir, 'test.db');
    const { id } = await create();
    await executor.closeAsync();

    executor = createNodeSqliteExecutor(path);
    await runMigrations(executor, FIXED_NOW);

    expect((await getMealById(executor, id))?.size).toBe('medium');
    expect(await listQueuedOperations(executor)).toHaveLength(1);
  });
});
