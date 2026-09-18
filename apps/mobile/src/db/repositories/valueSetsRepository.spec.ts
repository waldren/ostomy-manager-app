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

import { createNodeSqliteExecutor } from '../../test-support/nodeSqliteExecutor';
import type { SqliteExecutor } from '../executor';
import { runMigrations } from '../migrations';

import { readValueSet, VALUE_SET_KEY, writeValueSets } from './valueSetsRepository';

const FIXED_NOW = () => new Date('2026-09-17T12:00:00.000Z');
const FETCHED_AT = '2026-09-17T12:00:00.000Z';

describe('valueSetsRepository', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-valuesets-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The migration deliberately seeds nothing. A seeded default is a hardcoded
   * value set wearing a database costume — silently stale rather than absent,
   * so an admin who retired a member would have no way to discover a fielded
   * app was still offering it.
   */
  it('reports an empty set before anything has been fetched', async () => {
    expect(await readValueSet(executor, VALUE_SET_KEY.FLUID_TYPE)).toEqual([]);
  });

  it('round-trips a category set, in the admin-chosen order', async () => {
    await writeValueSets(
      executor,
      [
        {
          key: VALUE_SET_KEY.FLUID_TYPE,
          members: [
            { code: 'juice', sortOrder: 40, numericValue: null, numericUnit: null },
            { code: 'water', sortOrder: 10, numericValue: null, numericUnit: null },
          ],
        },
      ],
      FETCHED_AT,
    );

    const members = await readValueSet(executor, VALUE_SET_KEY.FLUID_TYPE);

    expect(members.map((member) => member.code)).toEqual(['water', 'juice']);
    expect(members[0]?.numericValue).toBeNull();
  });

  it('round-trips a container size with its canonical quantity (AC 2.3 AC2)', async () => {
    await writeValueSets(
      executor,
      [
        {
          key: VALUE_SET_KEY.CONTAINER_SIZE,
          members: [{ code: 'glass_250', sortOrder: 20, numericValue: 250, numericUnit: 'mL' }],
        },
      ],
      FETCHED_AT,
    );

    const [member] = await readValueSet(executor, VALUE_SET_KEY.CONTAINER_SIZE);

    expect(member).toEqual({
      code: 'glass_250',
      sortOrder: 20,
      numericValue: 250,
      numericUnit: 'mL',
    });
  });

  it('keeps a decimal quantity exactly', async () => {
    await writeValueSets(
      executor,
      [
        {
          key: VALUE_SET_KEY.CONTAINER_SIZE,
          members: [{ code: 'shot_44_4', sortOrder: 1, numericValue: 44.4, numericUnit: 'mL' }],
        },
      ],
      FETCHED_AT,
    );

    expect((await readValueSet(executor, VALUE_SET_KEY.CONTAINER_SIZE))[0]?.numericValue).toBe(
      44.4,
    );
  });

  /**
   * The reason this replaces rather than upserts. A retired member is simply
   * ABSENT from the server's response, never marked — so an upsert would leave
   * it behind and the screen would keep offering it forever, with nothing
   * detecting the drift. CLAUDE.md: "No admin action may change what a past
   * entry means" — but it must absolutely change what a NEW entry can say.
   */
  it('drops a member the server has stopped returning, because that is what retirement looks like', async () => {
    await writeValueSets(
      executor,
      [
        {
          key: VALUE_SET_KEY.MEAL_TAG,
          members: [
            { code: 'dairy', sortOrder: 10, numericValue: null, numericUnit: null },
            { code: 'retired_tag', sortOrder: 20, numericValue: null, numericUnit: null },
          ],
        },
      ],
      FETCHED_AT,
    );

    await writeValueSets(
      executor,
      [
        {
          key: VALUE_SET_KEY.MEAL_TAG,
          members: [{ code: 'dairy', sortOrder: 10, numericValue: null, numericUnit: null }],
        },
      ],
      '2026-09-18T12:00:00.000Z',
    );

    const members = await readValueSet(executor, VALUE_SET_KEY.MEAL_TAG);
    expect(members.map((member) => member.code)).toEqual(['dairy']);
  });

  /**
   * Scoped to the sets actually returned. A response that omits a set this
   * build does not yet use must not empty one it does.
   */
  it('leaves a set the refresh did not mention alone', async () => {
    await writeValueSets(
      executor,
      [
        {
          key: VALUE_SET_KEY.FLUID_TYPE,
          members: [{ code: 'water', sortOrder: 10, numericValue: null, numericUnit: null }],
        },
        {
          key: VALUE_SET_KEY.MEAL_TAG,
          members: [{ code: 'dairy', sortOrder: 10, numericValue: null, numericUnit: null }],
        },
      ],
      FETCHED_AT,
    );

    await writeValueSets(
      executor,
      [
        {
          key: VALUE_SET_KEY.FLUID_TYPE,
          members: [{ code: 'juice', sortOrder: 10, numericValue: null, numericUnit: null }],
        },
      ],
      '2026-09-18T12:00:00.000Z',
    );

    expect((await readValueSet(executor, VALUE_SET_KEY.MEAL_TAG)).map((m) => m.code)).toEqual([
      'dairy',
    ]);
  });

  /**
   * A 0 mL quick-select button would fill the volume field with a value Tier 1
   * then blocks — a control that looks usable and cannot be used.
   */
  it('treats an unparseable quantity as no quantity rather than as zero', async () => {
    await executor.runAsync(
      `INSERT INTO value_set_members_cache
         (value_set_key, code, sort_order, numeric_value, numeric_unit, fetched_at)
       VALUES (?, ?, 0, ?, 'mL', ?);`,
      [VALUE_SET_KEY.CONTAINER_SIZE, 'broken', 'not-a-number', FETCHED_AT],
    );

    expect(
      (await readValueSet(executor, VALUE_SET_KEY.CONTAINER_SIZE))[0]?.numericValue,
    ).toBeNull();
  });

  it('survives closing and reopening the database', async () => {
    const path = join(dir, 'test.db');
    await writeValueSets(
      executor,
      [
        {
          key: VALUE_SET_KEY.FLUID_TYPE,
          members: [{ code: 'water', sortOrder: 10, numericValue: null, numericUnit: null }],
        },
      ],
      FETCHED_AT,
    );
    await executor.closeAsync();

    executor = createNodeSqliteExecutor(path);
    await runMigrations(executor, FIXED_NOW);

    expect((await readValueSet(executor, VALUE_SET_KEY.FLUID_TYPE)).map((m) => m.code)).toEqual([
      'water',
    ]);
  });
});
