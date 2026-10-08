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

import { readProfile, writeProfile, type LocalProfile } from './profileRepository';

const FIXED_NOW = () => new Date('2026-10-08T12:00:00.000Z');
const FETCHED_AT = '2026-10-08T12:00:00.000Z';

const PROFILE: LocalProfile = {
  ostomyType: 'ileostomy',
  surgeryDate: '2026-09-01',
  measurementSystem: 'metric',
};

/**
 * Replaces `profiles` with an unconstrained table of the same shape, so a test
 * can produce the row a future migration — or a hand edit — could leave behind.
 *
 * Rewriting `sqlite_master` in place would be closer to the real accident, but
 * `node:sqlite` refuses to modify it even under `PRAGMA writable_schema`. What
 * matters for the branch under test is the row, not how it got there.
 */
const WIDEN_PROFILES_TABLE = `
  DROP TABLE profiles;
  CREATE TABLE profiles (
    id INTEGER PRIMARY KEY,
    ostomy_type TEXT NOT NULL,
    surgery_date TEXT NOT NULL,
    measurement_system TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
`;

/** The one write in this file that bypasses the repository, for the reason above. */
const INSERT_RAW_PROFILE = `
  INSERT INTO profiles (id, ostomy_type, surgery_date, measurement_system, fetched_at)
  VALUES (1, ?, '2026-09-01', ?, '2026-10-08T12:00:00.000Z');
`;

describe('profileRepository', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-profile-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The table is deliberately unseeded, and this is the assertion that keeps it
   * that way: `undefined` here is what routes a signed-in patient to onboarding,
   * so a migration that seeded a default profile would send every new patient
   * straight to a dashboard with a measurement system nobody chose and a surgery
   * date nobody gave.
   */
  it('reads undefined on a fresh database — no row means this device has no profile', async () => {
    await expect(readProfile(executor)).resolves.toBeUndefined();
  });

  it('round-trips the three fields', async () => {
    await writeProfile(executor, PROFILE, FETCHED_AT);
    await expect(readProfile(executor)).resolves.toEqual(PROFILE);
  });

  /**
   * The surgery date must come back as the same ten characters it went in as.
   *
   * It is a calendar date, and the one way this goes wrong is a reader turning it
   * into an instant and back: `new Date('2026-01-01')` is UTC midnight, so a
   * device west of UTC that formats it locally gets the day before — and this
   * value is the Tier 1 lower bound entries are compared against, so a one-day
   * shift either refuses a legitimate entry made on the day of surgery or accepts
   * one from a day when there was no stoma.
   */
  it('keeps the surgery date as a calendar date, byte for byte', async () => {
    await writeProfile(executor, { ...PROFILE, surgeryDate: '2026-01-01' }, FETCHED_AT);
    const read = await readProfile(executor);
    expect(read?.surgeryDate).toBe('2026-01-01');
  });

  it('carries imperial through unchanged — the path nothing in the app could reach before', async () => {
    await writeProfile(executor, { ...PROFILE, measurementSystem: 'imperial' }, FETCHED_AT);
    const read = await readProfile(executor);
    expect(read?.measurementSystem).toBe('imperial');
  });

  /**
   * Re-provisioning replaces rather than collides.
   *
   * Reachable today: a development reset empties the server while this device
   * keeps its store, the patient re-onboards, and an INSERT with no upsert would
   * fail on the primary key and leave the device holding the OLD profile while the
   * server holds the new one — two different surgery dates for one patient, with
   * the device's being the one that bounds entries.
   */
  it('a second write replaces the single row rather than failing or adding one', async () => {
    await writeProfile(executor, PROFILE, FETCHED_AT);
    await writeProfile(
      executor,
      { ostomyType: 'colostomy', surgeryDate: '2026-10-01', measurementSystem: 'imperial' },
      '2026-10-08T13:00:00.000Z',
    );

    const rows = await executor.getAllAsync<{ count: number }>(
      'SELECT COUNT(*) AS count FROM profiles;',
    );
    expect(rows[0]?.count).toBe(1);
    await expect(readProfile(executor)).resolves.toEqual({
      ostomyType: 'colostomy',
      surgeryDate: '2026-10-01',
      measurementSystem: 'imperial',
    });
  });

  /**
   * A row this build cannot make sense of is no row at all.
   *
   * Written past the repository on purpose — migration 8's CHECK constraints make
   * this unreachable through `writeProfile`, which is exactly why the branch needs
   * its own test. The alternative behaviour is the dangerous one: a profile whose
   * measurement system fell back to a default would render every amount in the app
   * in units the patient never chose, with nothing reporting it.
   */
  it('treats a row whose measurement system does not parse as no profile', async () => {
    await executor.execAsync(WIDEN_PROFILES_TABLE);
    await executor.runAsync(INSERT_RAW_PROFILE, ['ileostomy', 'stones']);

    await expect(readProfile(executor)).resolves.toBeUndefined();
  });

  it('treats a row whose ostomy type does not parse as no profile', async () => {
    await executor.execAsync(WIDEN_PROFILES_TABLE);
    await executor.runAsync(INSERT_RAW_PROFILE, ['urostomy', 'metric']);

    await expect(readProfile(executor)).resolves.toBeUndefined();
  });

  /**
   * The constraints are the first line, and worth asserting: they are what makes
   * the two branches above unreachable through this app's own writes rather than
   * merely unlikely.
   */
  it('refuses a second row, so "the profile" can never be ambiguous', async () => {
    await writeProfile(executor, PROFILE, FETCHED_AT);
    await expect(
      executor.runAsync(
        `INSERT INTO profiles (id, ostomy_type, surgery_date, measurement_system, fetched_at)
         VALUES (2, 'colostomy', '2026-09-02', 'imperial', ?);`,
        [FETCHED_AT],
      ),
    ).rejects.toThrow();
  });

  it('refuses an ostomy type the server does not accept', async () => {
    await expect(
      executor.runAsync(
        `INSERT INTO profiles (id, ostomy_type, surgery_date, measurement_system, fetched_at)
         VALUES (1, 'urostomy', '2026-09-02', 'metric', ?);`,
        [FETCHED_AT],
      ),
    ).rejects.toThrow();
  });
});
