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

/**
 * The drift guard for `URINE_COLOR_CODES_PALE_TO_DARK`, which is a deliberate
 * second copy of a clinical ordering.
 *
 * The authoritative order is `value_set_members.sort_order`, seeded by the
 * P3.S2 migration. `apps/mobile` reads it from the device's value-set cache;
 * `apps/web` has no value-set fetch at all, so the shared constant is what
 * both clients can agree on without either inventing its own sequence.
 *
 * ## Why this test exists alongside the integration one
 *
 * `observations.integration.spec.ts` asserts the same equality against real
 * PostgreSQL, which proves the migration actually applied. But that suite
 * **skips itself when Docker is unreachable** — CLAUDE.md says so in its own
 * words — so on a machine without a daemon the only guard on a clinical
 * ordering silently does not run.
 *
 * This one reads the migration file off disk, so it runs everywhere and fails
 * at the moment the drift is introduced rather than at the moment someone
 * happens to have Docker up. The integration test keeps its own job: proving
 * the file was executed.
 *
 * Parsing SQL with a regex is ordinarily a bad idea. It is acceptable here
 * because the target is a `VALUES` list this repo wrote and controls, the
 * failure mode is a test that cannot find its tuples (loud), and the
 * alternative is no unskippable guard at all.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { URINE_COLOR_CODES_PALE_TO_DARK } from './netFluidBalance.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATION = resolve(
  here,
  '../../../../apps/api/prisma/migrations/20260923180000_add_voided_urine/migration.sql',
);

/** The `('code', sort_order)` tuples of the migration's `urine_color` member seed. */
function seededMembers(): readonly { code: string; sortOrder: number }[] {
  const sql = readFileSync(MIGRATION, 'utf-8');
  const matches = [...sql.matchAll(/\('([a-z_]+)',\s*(\d+)\)/g)].map((match) => ({
    code: match[1] as string,
    sortOrder: Number(match[2]),
  }));

  // Loud rather than vacuously green: an empty list would make every
  // assertion below pass while proving nothing, which is the failure mode of
  // the `urine_color_scale` test this whole class of guard replaced.
  expect(matches.length).toBeGreaterThan(0);
  return matches;
}

describe('the urine colour scale has one ordering, in two places', () => {
  it('matches the order the migration seeds', () => {
    const seeded = [...seededMembers()].sort((a, b) => a.sortOrder - b.sortOrder);

    expect(seeded.map((member) => member.code)).toEqual([...URINE_COLOR_CODES_PALE_TO_DARK]);
  });

  /**
   * The migration numbers in tens so a future step can be inserted between two
   * without renumbering rows history already references. That only works while
   * the numbers are distinct and ascending — a duplicate `sort_order` makes the
   * database's own ordering non-deterministic, and then no constant can agree
   * with it.
   */
  it('seeds strictly ascending, distinct sort orders', () => {
    const orders = seededMembers().map((member) => member.sortOrder);

    expect(new Set(orders).size).toBe(orders.length);
    expect([...orders].sort((a, b) => a - b)).toEqual(orders);
  });
});
