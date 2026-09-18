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

import type { SyncDeltaResponse } from '@ostomy/core/api-client';

import type { SqliteExecutor } from '../db/executor';
import { runMigrations } from '../db/migrations';
import { enqueueMealCreate } from '../db/offlineWrites';
import { getMealById } from '../db/repositories/mealsRepository';
import { getCursor } from '../db/repositories/syncCursorRepository';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { applyDeltaPage } from './deltaPull';
import { decodeDeltaPage } from './responseDecoding';

const FIXED_NOW = () => new Date('2026-09-17T12:00:00.000Z');
const APPLIED_AT = '2026-09-17T12:00:00.000Z';
const MEAL_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Every fixture goes through the real decoder, so these tests exercise the boundary rather than bypassing it. */
function page(raw: SyncDeltaResponse) {
  return decodeDeltaPage(raw);
}

function mealUpsertPage(options: {
  entityId?: string;
  serverSequence: string;
  clientUpdatedAt: string;
  cursor: string;
  size?: unknown;
  description?: unknown;
  tagCodes?: unknown;
  effectiveDateTime?: string;
  enteredTimezone?: string;
}): SyncDeltaResponse {
  const entityId = options.entityId ?? MEAL_ID;
  return {
    changes: [
      {
        entityType: 'Meal',
        entityId,
        serverSequence: options.serverSequence,
        deleted: false,
        clientUpdatedAt: options.clientUpdatedAt,
        payload: {
          id: entityId,
          description: options.description === undefined ? 'Porridge' : options.description,
          size: options.size === undefined ? 'medium' : options.size,
          tagCodes: options.tagCodes === undefined ? ['high_fibre'] : options.tagCodes,
          effectiveDateTime: options.effectiveDateTime ?? '2026-09-17T11:00:00.000Z',
          enteredTimezone: options.enteredTimezone ?? 'America/Chicago',
        },
      },
    ],
    cursor: options.cursor,
    hasMore: false,
  } as unknown as SyncDeltaResponse;
}

function mealTombstonePage(options: {
  entityId?: string;
  serverSequence: string;
  clientUpdatedAt: string;
  cursor: string;
}): SyncDeltaResponse {
  return {
    changes: [
      {
        entityType: 'Meal',
        entityId: options.entityId ?? MEAL_ID,
        serverSequence: options.serverSequence,
        deleted: true,
        clientUpdatedAt: options.clientUpdatedAt,
      },
    ],
    cursor: options.cursor,
    hasMore: false,
  } as unknown as SyncDeltaResponse;
}

describe('applyDeltaPage, for meals (§5.2, §7.4)', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-delta-meal-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * P3.S1 PR D decoded a meal as `unsupported-entity` because the client had
   * nowhere to put one. This is the assertion that PR E actually undid that,
   * rather than leaving a second device's meals permanently invisible.
   */
  it('inserts a meal this device has never seen', async () => {
    const outcome = await applyDeltaPage(
      executor,
      page(
        mealUpsertPage({
          serverSequence: '100',
          clientUpdatedAt: '2026-09-17T11:00:00.000Z',
          cursor: '100',
        }),
      ),
      APPLIED_AT,
    );

    expect(outcome).toMatchObject({ upserts: 1, unsupportedEntity: 0, undecodable: 0 });
    expect(await getMealById(executor, MEAL_ID)).toMatchObject({
      description: 'Porridge',
      size: 'medium',
      tagCodes: ['high_fibre'],
      serverSequence: '100',
    });
  });

  /** ADR-0016 — absent from the wire on purpose, derived on both sides by the same helper. */
  it('derives localDate locally from the payload instant and zone', async () => {
    // 02:30 UTC on the 18th is still the 17th in Chicago (UTC-5 in September).
    await applyDeltaPage(
      executor,
      page(
        mealUpsertPage({
          serverSequence: '100',
          clientUpdatedAt: '2026-09-18T02:30:00.000Z',
          effectiveDateTime: '2026-09-18T02:30:00.000Z',
          cursor: '100',
        }),
      ),
      APPLIED_AT,
    );

    expect((await getMealById(executor, MEAL_ID))?.localDate).toBe('2026-09-17');
  });

  it('overwrites every field of a meal it already holds', async () => {
    await applyDeltaPage(
      executor,
      page(
        mealUpsertPage({
          serverSequence: '100',
          clientUpdatedAt: '2026-09-17T11:00:00.000Z',
          cursor: '100',
        }),
      ),
      APPLIED_AT,
    );

    await applyDeltaPage(
      executor,
      page(
        mealUpsertPage({
          serverSequence: '200',
          clientUpdatedAt: '2026-09-17T11:30:00.000Z',
          description: 'Soup',
          size: 'large',
          tagCodes: [],
          cursor: '200',
        }),
      ),
      APPLIED_AT,
    );

    expect(await getMealById(executor, MEAL_ID)).toMatchObject({
      description: 'Soup',
      size: 'large',
      tagCodes: [],
      serverSequence: '200',
    });
  });

  describe('last-write-wins against a locally queued meal (§4)', () => {
    /**
     * The scenario this protects: the patient logs a meal, is told it is saved
     * (§9.5), and a delta page arrives holding the server's older version
     * before the queued operation has pushed. Applying it would make the entry
     * change under them and change back one cycle later.
     */
    it('does not apply a version older than the one this device holds', async () => {
      const { id } = await enqueueMealCreate(
        executor,
        {
          description: 'Local supper',
          size: 'large',
          tagCodes: ['dairy'],
          effectiveDatetime: '2026-09-17T11:30:00.000Z',
        },
        FIXED_NOW,
      );

      const outcome = await applyDeltaPage(
        executor,
        page(
          mealUpsertPage({
            entityId: id,
            serverSequence: '100',
            // Older than FIXED_NOW, which is what the local write stamped.
            clientUpdatedAt: '2026-09-17T09:00:00.000Z',
            description: 'Server supper',
            size: 'small',
            cursor: '100',
          }),
        ),
        APPLIED_AT,
      );

      expect(outcome.skippedAsStale).toBe(1);
      expect(await getMealById(executor, id)).toMatchObject({
        description: 'Local supper',
        size: 'large',
      });
    });

    /** §4's table resolves a tie in favour of the incoming version. The two sides must not disagree about one. */
    it('applies a version with an equal timestamp', async () => {
      const { id } = await enqueueMealCreate(
        executor,
        {
          description: 'Local supper',
          size: 'large',
          tagCodes: [],
          effectiveDatetime: '2026-09-17T11:30:00.000Z',
        },
        FIXED_NOW,
      );

      await applyDeltaPage(
        executor,
        page(
          mealUpsertPage({
            entityId: id,
            serverSequence: '100',
            clientUpdatedAt: APPLIED_AT,
            description: 'Server supper',
            cursor: '100',
          }),
        ),
        APPLIED_AT,
      );

      expect((await getMealById(executor, id))?.description).toBe('Server supper');
    });
  });

  describe('tombstones', () => {
    it('tombstones a meal in place, keeping its clinical values (§5.2)', async () => {
      await applyDeltaPage(
        executor,
        page(
          mealUpsertPage({
            serverSequence: '100',
            clientUpdatedAt: '2026-09-17T11:00:00.000Z',
            cursor: '100',
          }),
        ),
        APPLIED_AT,
      );

      const outcome = await applyDeltaPage(
        executor,
        page(
          mealTombstonePage({
            serverSequence: '200',
            clientUpdatedAt: '2026-09-17T11:30:00.000Z',
            cursor: '200',
          }),
        ),
        APPLIED_AT,
      );

      expect(outcome.tombstones).toBe(1);
      const meal = await getMealById(executor, MEAL_ID);
      expect(meal?.deletedAt).not.toBeNull();
      // A tombstone carries no payload, so nothing on the wire could
      // repopulate these — a row whose values were blanked is
      // indistinguishable from one that was written empty.
      expect(meal?.description).toBe('Porridge');
      expect(meal?.size).toBe('medium');
    });

    /** The row is already absent, which is the state the tombstone asks for. */
    it('treats a tombstone for a meal it never saw as applied, not as an error', async () => {
      const outcome = await applyDeltaPage(
        executor,
        page(
          mealTombstonePage({
            serverSequence: '200',
            clientUpdatedAt: '2026-09-17T11:30:00.000Z',
            cursor: '200',
          }),
        ),
        APPLIED_AT,
      );

      expect(outcome).toMatchObject({ tombstones: 1, skippedAsStale: 0 });
      expect(await getMealById(executor, MEAL_ID)).toBeUndefined();
    });
  });

  /**
   * §8 lets the server add a size without a client release. A value outside
   * the three-step scale is not writable — the column's CHECK would refuse it
   * — and inventing one would record a clinical judgement the patient never
   * made (AC 2.4 AC2). So the meal is skipped and the cursor still advances,
   * which §5.3 permits.
   */
  it('skips a meal whose size is outside the scale this build knows, and still advances the cursor', async () => {
    const outcome = await applyDeltaPage(
      executor,
      page(
        mealUpsertPage({
          serverSequence: '100',
          clientUpdatedAt: '2026-09-17T11:00:00.000Z',
          size: 'enormous',
          cursor: '100',
        }),
      ),
      APPLIED_AT,
    );

    expect(outcome).toMatchObject({ upserts: 0, skippedAsStale: 1 });
    expect(await getMealById(executor, MEAL_ID)).toBeUndefined();
    expect(await getCursor(executor)).toBe('100');
  });

  /**
   * Tags are an optional annotation: losing them degrades the row, while
   * refusing the change would lose the meal itself.
   */
  it('accepts a meal whose tagCodes are absent, as no tags', async () => {
    await applyDeltaPage(
      executor,
      page(
        mealUpsertPage({
          serverSequence: '100',
          clientUpdatedAt: '2026-09-17T11:00:00.000Z',
          tagCodes: null,
          cursor: '100',
        }),
      ),
      APPLIED_AT,
    );

    expect((await getMealById(executor, MEAL_ID))?.tagCodes).toEqual([]);
  });

  it('carries a meal and an observation in one page without either blocking the other', async () => {
    const raw = {
      changes: [
        {
          entityType: 'Observation',
          entityId: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          serverSequence: '452',
          deleted: false,
          clientUpdatedAt: '2026-09-17T11:00:00.000Z',
          payload: {
            resourceType: 'Observation',
            id: 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            status: 'final',
            code: '79560-9',
            valueQuantity: { value: 350, unit: 'mL' },
            effectiveDateTime: '2026-09-17T11:00:00.000Z',
            method: null,
            enteredMeasurementSystem: 'metric',
            enteredTimezone: 'America/Chicago',
          },
        },
        {
          entityType: 'Meal',
          entityId: MEAL_ID,
          serverSequence: '453',
          deleted: false,
          clientUpdatedAt: '2026-09-17T11:05:00.000Z',
          payload: {
            id: MEAL_ID,
            description: 'Porridge',
            size: 'small',
            tagCodes: [],
            effectiveDateTime: '2026-09-17T11:05:00.000Z',
            enteredTimezone: 'America/Chicago',
          },
        },
      ],
      cursor: '453',
      hasMore: false,
    } as unknown as SyncDeltaResponse;

    const outcome = await applyDeltaPage(executor, page(raw), APPLIED_AT);

    expect(outcome).toMatchObject({ upserts: 2, undecodable: 0, unsupportedEntity: 0 });
    expect(await getMealById(executor, MEAL_ID)).toBeDefined();
    expect(await getCursor(executor)).toBe('453');
  });
});
