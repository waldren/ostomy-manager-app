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

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { insertObservation } from './repositories/observationsRepository';
import { latestSchemaVersion, runMigrations } from './migrations';

describe('local schema — applies and survives a close/reopen cycle', () => {
  let dir: string;
  let dbFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-schema-'));
    dbFile = join(dir, 'test.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates observations, sync_queue, and sync_cursor on a fresh database', async () => {
    const executor = createNodeSqliteExecutor(dbFile);
    await runMigrations(executor, () => new Date('2026-09-11T12:00:00.000Z'));

    const tables = await executor.getAllAsync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name;",
    );
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toEqual(
      expect.arrayContaining(['observations', 'sync_queue', 'sync_cursor', 'schema_migrations']),
    );

    await executor.closeAsync();
  });

  it('seeds sync_cursor to "0" (docs/sync-contract.md §5.1 — "since=0 requests everything")', async () => {
    const executor = createNodeSqliteExecutor(dbFile);
    await runMigrations(executor, () => new Date('2026-09-11T12:00:00.000Z'));

    const rows = await executor.getAllAsync<{ cursor: string }>('SELECT cursor FROM sync_cursor;');
    expect(rows).toEqual([{ cursor: '0' }]);

    await executor.closeAsync();
  });

  it('records every applied migration version, up to the latest defined', async () => {
    const executor = createNodeSqliteExecutor(dbFile);
    await runMigrations(executor, () => new Date('2026-09-11T12:00:00.000Z'));

    const rows = await executor.getAllAsync<{ version: number }>(
      'SELECT version FROM schema_migrations ORDER BY version ASC;',
    );
    expect(rows.map((r) => r.version)).toEqual(
      Array.from({ length: latestSchemaVersion() }, (_, i) => i + 1),
    );

    await executor.closeAsync();
  });

  it('running migrations twice is a no-op the second time (idempotent on every app launch)', async () => {
    const executor = createNodeSqliteExecutor(dbFile);
    await runMigrations(executor, () => new Date('2026-09-11T12:00:00.000Z'));
    await runMigrations(executor, () => new Date('2026-09-11T12:05:00.000Z'));

    const rows = await executor.getAllAsync<{ version: number }>(
      'SELECT version FROM schema_migrations;',
    );
    expect(rows).toHaveLength(latestSchemaVersion());

    await executor.closeAsync();
  });

  it(
    'a row written before close is still present after the connection closes and a new one reopens the same file — ' +
      'the mechanism "survives app restart and OS background termination" depends on (see nodeSqliteExecutor.ts header comment)',
    async () => {
      const firstConnection = createNodeSqliteExecutor(dbFile);
      await runMigrations(firstConnection, () => new Date('2026-09-11T12:00:00.000Z'));
      await insertObservation(
        firstConnection,
        {
          id: '11111111-1111-4111-8111-111111111111',
          code: '79560-9',
          valueQuantityValue: '350.0000',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-11T14:00:00.000Z',
          method: null,
          status: 'final',
          enteredMeasurementSystem: 'metric',
          enteredTimezone: 'America/Chicago',
          localDate: '2026-09-11',
          fluidTypeCode: null,
          urineColorCode: null,
          clientUpdatedAt: '2026-09-11T22:04:11.412Z',
        },
        '2026-09-11T22:04:11.412Z',
      );

      // Simulates app termination: the connection is gone, nothing is held
      // in memory, and the only thing that could make the row reappear is
      // the on-disk file itself.
      await firstConnection.closeAsync();

      expect(existsSync(dbFile)).toBe(true);

      // Simulates a relaunch: a brand-new executor, a brand-new connection,
      // no shared in-memory state with the first one at all.
      const secondConnection = createNodeSqliteExecutor(dbFile);
      const rows = await secondConnection.getAllAsync<{ id: string; code: string }>(
        'SELECT id, code FROM observations WHERE id = ?;',
        ['11111111-1111-4111-8111-111111111111'],
      );

      expect(rows).toEqual([{ id: '11111111-1111-4111-8111-111111111111', code: '79560-9' }]);

      // And migrations remain a no-op on the reopened file — no
      // re-creation, no data loss from a second migration pass.
      await runMigrations(secondConnection, () => new Date('2026-09-11T23:00:00.000Z'));
      const stillThere = await secondConnection.getAllAsync<{ id: string }>(
        'SELECT id FROM observations WHERE id = ?;',
        ['11111111-1111-4111-8111-111111111111'],
      );
      expect(stillThere).toHaveLength(1);

      await secondConnection.closeAsync();
    },
  );

  it('rejects a value_quantity_unit outside {mL, kg} — schema-level backstop behind the packages/core type', async () => {
    const executor = createNodeSqliteExecutor(dbFile);
    await runMigrations(executor, () => new Date('2026-09-11T12:00:00.000Z'));

    await expect(
      insertObservation(
        executor,
        {
          id: '22222222-2222-4222-8222-222222222222',
          code: '79560-9',
          // @ts-expect-error — deliberately invalid to prove the CHECK constraint holds even if a caller bypasses the type.
          valueQuantityUnit: 'oz',
          valueQuantityValue: '8.0000',
          effectiveDatetime: '2026-09-11T14:00:00.000Z',
          method: null,
          status: 'final',
          enteredMeasurementSystem: 'imperial',
          enteredTimezone: 'America/Chicago',
          localDate: '2026-09-11',
          fluidTypeCode: null,
          clientUpdatedAt: '2026-09-11T22:04:11.412Z',
        },
        '2026-09-11T22:04:11.412Z',
      ),
    ).rejects.toThrow();

    await executor.closeAsync();
  });
});
