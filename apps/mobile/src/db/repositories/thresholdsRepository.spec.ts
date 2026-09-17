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

import { readThresholds, writeThresholds } from './thresholdsRepository';

const FIXED_NOW = () => new Date('2026-09-16T12:00:00.000Z');
const FETCHED_AT = '2026-09-16T12:00:00.000Z';

describe('thresholdsRepository', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-thresholds-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The migration deliberately seeds no row. A seeded default is a hardcoded
   * threshold wearing a database costume — it satisfies the injection
   * interface while making the rule it exists to enforce false, and it would
   * be silently wrong rather than absent.
   */
  it('reports no cache before anything has been fetched', async () => {
    expect(await readThresholds(executor)).toBeUndefined();
  });

  it('round-trips the fetched values', async () => {
    await writeThresholds(
      executor,
      { softWarningMaxMl: 2000, maxClockSkewMs: 300_000 },
      FETCHED_AT,
    );

    const cached = await readThresholds(executor);

    expect(cached?.thresholds).toEqual({ softWarningMaxMl: 2000, maxClockSkewMs: 300_000 });
    expect(cached?.fetchedAt).toBe(FETCHED_AT);
  });

  /** AC 13.2 AC2: an admin change governs from the next successful fetch, with no application release. */
  it('replaces the previous values rather than accumulating rows', async () => {
    await writeThresholds(
      executor,
      { softWarningMaxMl: 2000, maxClockSkewMs: 300_000 },
      FETCHED_AT,
    );
    await writeThresholds(
      executor,
      { softWarningMaxMl: 1500, maxClockSkewMs: 60_000 },
      '2026-09-17T12:00:00.000Z',
    );

    const cached = await readThresholds(executor);

    expect(cached?.thresholds.softWarningMaxMl).toBe(1500);
    const rows = await executor.getAllAsync('SELECT * FROM validation_thresholds_cache;');
    expect(rows).toHaveLength(1);
  });

  it('keeps a decimal threshold exactly', async () => {
    await writeThresholds(
      executor,
      { softWarningMaxMl: 1999.5, maxClockSkewMs: 300_000 },
      FETCHED_AT,
    );

    expect((await readThresholds(executor))?.thresholds.softWarningMaxMl).toBe(1999.5);
  });

  /**
   * A row that does not parse must read as "no cache", never as zeroes. A
   * `softWarningMaxMl` of 0 would warn on every entry a patient ever makes,
   * and a `maxClockSkewMs` of 0 would block any entry a millisecond ahead —
   * both plausible-looking behaviour with no error anywhere.
   */
  it('treats an unparseable cached row as no cache at all', async () => {
    await executor.runAsync(
      `INSERT INTO validation_thresholds_cache (id, stoma_output_soft_warning_ml, max_clock_skew_ms, fetched_at)
       VALUES (1, ?, ?, ?);`,
      ['', 'not-a-number', FETCHED_AT],
    );

    expect(await readThresholds(executor)).toBeUndefined();
  });

  /** The cache must survive the close/reopen cycle that stands in for app restart and OS background termination. */
  it('survives closing and reopening the database', async () => {
    const path = join(dir, 'test.db');
    await writeThresholds(
      executor,
      { softWarningMaxMl: 2000, maxClockSkewMs: 300_000 },
      FETCHED_AT,
    );
    await executor.closeAsync();

    executor = createNodeSqliteExecutor(path);
    await runMigrations(executor, FIXED_NOW);

    expect((await readThresholds(executor))?.thresholds.softWarningMaxMl).toBe(2000);
  });
});
