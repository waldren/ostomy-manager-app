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

import type { VolumetricValidationThresholds } from '@ostomy/core/validation';

import type { SqliteExecutor } from '../executor';

/**
 * The device's cached copy of the admin-managed validation thresholds
 * (`GET /api/v1/thresholds`).
 *
 * Exists because two requirements meet here: thresholds are configuration
 * and never constants in code (CLAUDE.md), and this app validates offline,
 * where nothing can be fetched. So the last-known values rest on the device
 * and the entry screen injects them into `@ostomy/core/validation`.
 *
 * **There is no default and no fallback**, deliberately. A default here
 * would be a hardcoded threshold wearing a database costume: it satisfies
 * the injection interface while making the rule false, and — worse — it
 * would be silently wrong rather than absent, so an operator who changed the
 * real value would have no way to discover that a fielded app was comparing
 * against something else. `readThresholds` returns `undefined` until a fetch
 * has succeeded, and the entry screen is expected to refuse the save rather
 * than invent numbers. See `../schema.ts`'s migration-4 comment.
 */

export interface CachedThresholds {
  readonly thresholds: VolumetricValidationThresholds;
  /** When this device last fetched them. Diagnostic only — staleness is not an error, since an offline device is expected to validate against an old copy. */
  readonly fetchedAt: string;
}

interface ThresholdsRawRow {
  stoma_output_soft_warning_ml: string;
  max_clock_skew_ms: string;
  fetched_at: string;
}

export async function readThresholds(
  executor: SqliteExecutor,
): Promise<CachedThresholds | undefined> {
  const rows = await executor.getAllAsync<ThresholdsRawRow>(
    'SELECT * FROM validation_thresholds_cache WHERE id = 1;',
  );
  const row = rows[0];
  if (row === undefined) return undefined;

  const softWarningMaxMl = Number(row.stoma_output_soft_warning_ml);
  const maxClockSkewMs = Number(row.max_clock_skew_ms);

  // A cache row that does not parse is treated as no cache at all rather
  // than as zeroes. `Number('')` is 0, and a `softWarningMaxMl` of 0 would
  // warn on every entry a patient ever makes while a `maxClockSkewMs` of 0
  // would block any entry whose timestamp is a millisecond ahead — both
  // plausible-looking behaviour with no error anywhere.
  if (!Number.isFinite(softWarningMaxMl) || !Number.isFinite(maxClockSkewMs)) {
    return undefined;
  }

  return {
    thresholds: { softWarningMaxMl, maxClockSkewMs },
    fetchedAt: row.fetched_at,
  };
}

/**
 * Replaces the cached copy. Called only from the sync worker's threshold
 * refresh — never from a screen, which must read what is cached and never
 * decide what it should be.
 *
 * Values are stored as the strings they arrived as, not re-formatted: the
 * column is TEXT for migration 1's numeric-precision reason, and `String(n)`
 * on a JSON-parsed number is its shortest round-tripping form.
 */
export async function writeThresholds(
  executor: SqliteExecutor,
  thresholds: VolumetricValidationThresholds,
  fetchedAt: string,
): Promise<void> {
  await executor.runAsync(
    `INSERT INTO validation_thresholds_cache (id, stoma_output_soft_warning_ml, max_clock_skew_ms, fetched_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       stoma_output_soft_warning_ml = excluded.stoma_output_soft_warning_ml,
       max_clock_skew_ms = excluded.max_clock_skew_ms,
       fetched_at = excluded.fetched_at;`,
    [String(thresholds.softWarningMaxMl), String(thresholds.maxClockSkewMs), fetchedAt],
  );
}
