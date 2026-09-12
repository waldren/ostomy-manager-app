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

import { toWireInstant } from '../lib/utils/clock';

import type { SqliteExecutor } from './executor';
import { SCHEMA_MIGRATIONS } from './schema';

interface SchemaMigrationRow {
  version: number;
}

/**
 * Applies every migration in `./schema.ts` with a `version` greater than
 * whatever this database has already recorded, in ascending order, each in
 * its own transaction. Idempotent and safe to call on every app launch —
 * on a fresh install it applies everything; on a relaunch after an OS
 * background kill it is a single cheap `SELECT` that applies nothing,
 * because the schema (like every table it creates) lives in the on-disk
 * file `expo-sqlite` already restored.
 *
 * `schema_migrations` itself is created outside any transaction, before
 * the version check — there is nothing to roll back if this exact
 * statement fails, and it must exist before the very first `SELECT`
 * against it below can succeed on a brand-new database file.
 */
export async function runMigrations(executor: SqliteExecutor, now: () => Date): Promise<void> {
  await executor.execAsync(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);',
  );

  const appliedRows = await executor.getAllAsync<SchemaMigrationRow>(
    'SELECT version FROM schema_migrations;',
  );
  const appliedVersions = new Set(appliedRows.map((row) => row.version));

  const pending = SCHEMA_MIGRATIONS.filter((migration) => !appliedVersions.has(migration.version))
    .slice()
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const appliedAt = toWireInstant(now());
    await executor.withTransactionAsync(async () => {
      await executor.execAsync(migration.sql({ seededAt: appliedAt }));
      await executor.runAsync(
        'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?);',
        [migration.version, appliedAt],
      );
    });
  }
}

/** The highest migration version currently defined — used by tests to assert a fresh database ends up fully migrated. */
export function latestSchemaVersion(): number {
  return SCHEMA_MIGRATIONS.reduce((max, migration) => Math.max(max, migration.version), 0);
}
