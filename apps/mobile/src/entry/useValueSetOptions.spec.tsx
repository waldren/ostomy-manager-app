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

import { renderHook, waitFor } from '@testing-library/react-native';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SqliteExecutor } from '../db/executor';
import { runMigrations } from '../db/migrations';
import { MEAL_SIZES } from '../db/repositories/mealsRepository';
import { VALUE_SET_KEY, writeValueSets } from '../db/repositories/valueSetsRepository';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { labelKeyFor, useValueSetOptions } from './useValueSetOptions';

import type { DatabaseState } from '../db/DatabaseProvider';

const mockDatabaseState = jest.fn<DatabaseState, []>();

jest.mock('../db/DatabaseProvider', () => ({
  useDatabaseState: () => mockDatabaseState(),
}));

const FIXED_NOW = () => new Date('2026-09-17T12:00:00.000Z');
const FETCHED_AT = '2026-09-17T12:00:00.000Z';

describe('useValueSetOptions', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-valuesets-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
    mockDatabaseState.mockReturnValue({ status: 'ready', executor });
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
    jest.clearAllMocks();
  });

  it('reports the cached members of one set, in the server’s order', async () => {
    await writeValueSets(
      executor,
      [
        {
          key: VALUE_SET_KEY.FLUID_TYPE,
          members: [
            { code: 'water', sortOrder: 1, numericValue: null, numericUnit: null },
            { code: 'oral_rehydration', sortOrder: 2, numericValue: null, numericUnit: null },
          ],
        },
      ],
      FETCHED_AT,
    );

    const { result } = await renderHook(() => useValueSetOptions(VALUE_SET_KEY.FLUID_TYPE));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(
      result.current.status === 'ready' ? result.current.members.map((m) => m.code) : [],
    ).toEqual(['water', 'oral_rehydration']);
  });

  /**
   * The cache is unseeded on purpose — a default there would be a hardcoded
   * value set wearing a database costume. So "nothing fetched yet" is a
   * reachable state a screen must be able to say out loud, rather than
   * rendering an empty box a patient will tap at.
   */
  it('reports an empty set as unavailable, not as ready-with-nothing', async () => {
    const { result } = await renderHook(() => useValueSetOptions(VALUE_SET_KEY.MEAL_TAG));

    await waitFor(() => {
      expect(result.current.status).toBe('unavailable');
    });
  });

  it('stays loading while the database is still opening', async () => {
    mockDatabaseState.mockReturnValue({ status: 'opening' });

    const { result } = await renderHook(() => useValueSetOptions(VALUE_SET_KEY.FLUID_TYPE));

    expect(result.current.status).toBe('loading');
  });

  /**
   * Both pickers this hook serves are optional (AC 2.3 AC1, AC 2.4 AC1), so a
   * read failure must degrade the picker and never block a save.
   */
  it('falls back to unavailable rather than throwing when the read fails', async () => {
    await executor.runAsync('DROP TABLE value_set_members_cache;');

    const { result } = await renderHook(() => useValueSetOptions(VALUE_SET_KEY.CONTAINER_SIZE));

    await waitFor(() => {
      expect(result.current.status).toBe('unavailable');
    });
  });

  it('carries a container size’s numeric value through, so a quick-select can be labelled', async () => {
    await writeValueSets(
      executor,
      [
        {
          key: VALUE_SET_KEY.CONTAINER_SIZE,
          members: [{ code: 'glass', sortOrder: 1, numericValue: 250, numericUnit: 'mL' }],
        },
      ],
      FETCHED_AT,
    );

    const { result } = await renderHook(() => useValueSetOptions(VALUE_SET_KEY.CONTAINER_SIZE));

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current.status === 'ready' ? result.current.members[0] : undefined).toMatchObject(
      {
        numericValue: 250,
        numericUnit: 'mL',
      },
    );
  });
});

describe('labelKeyFor', () => {
  it('resolves a code this release has copy for', () => {
    expect(labelKeyFor('fluidType', 'water')).toBe('common:fluidType.water');
  });

  /**
   * An admin can add a member after this app ships, so a member with no
   * catalog entry is a reachable state rather than a defensive one. Returning
   * `undefined` is what lets a screen say "Another option" instead of
   * rendering the literal string `undefined`, or a raw code, at a patient.
   */
  it('returns undefined for a code with no catalog entry', () => {
    expect(labelKeyFor('fluidType', 'kombucha')).toBeUndefined();
    expect(labelKeyFor('mealTag', 'not_a_real_tag')).toBeUndefined();
  });

  /** A key assembled from an unknown namespace must not resolve either. */
  it('returns undefined for a namespace it does not own', () => {
    expect(labelKeyFor('notANamespace', 'water')).toBeUndefined();
  });

  /**
   * `hasOwnProperty` via `Object.prototype`, not `en.common[key] !== undefined`
   * — a plain lookup would resolve `constructor` and `toString` off the
   * prototype chain and hand a screen a key that renders a function body.
   */
  it('does not resolve an inherited Object property as a label', () => {
    expect(labelKeyFor('', 'constructor')).toBeUndefined();
    expect(labelKeyFor('', 'toString')).toBeUndefined();
  });

  /**
   * Every code the entry screens render must have copy. A meal size is not a
   * value-set member — it is the fixed three-step scale the local column's
   * CHECK constraint enforces — so a missing label here is a shipped bug, not
   * the reachable "admin added a member" state above.
   */
  it('has copy for every meal size the local schema allows', () => {
    for (const size of MEAL_SIZES) {
      expect(labelKeyFor('mealSize', size)).toBe(`common:mealSize.${size}`);
    }
  });
});
