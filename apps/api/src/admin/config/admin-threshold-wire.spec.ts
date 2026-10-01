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
 * The admin threshold wire contract.
 *
 * Outside the integration suite on purpose — that one skips itself when Docker is
 * unreachable, and the most important assertions in this file are about what the API
 * REFUSES. A refusal that silently stops being enforced is exactly the kind of thing a
 * skipped suite hides.
 */
import { MAX_REPRESENTABLE_VALUE_ML } from '@ostomy/core/admin';
import { describe, expect, it } from 'vitest';

import { updateThresholdSchema } from './admin-threshold-wire';

function reject(body: unknown): { field: string; rule: string }[] {
  const parsed = updateThresholdSchema.safeParse(body);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error('unreachable');
  return parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), rule: issue.code }));
}

describe('what a threshold update may contain', () => {
  it('accepts a value alone', async () => {
    expect(updateThresholdSchema.safeParse({ value: 1500 }).success).toBe(true);
  });

  it('accepts a value with a new admin label', async () => {
    expect(updateThresholdSchema.safeParse({ value: 1500, description: 'tightened' }).success).toBe(
      true,
    );
  });

  it('requires a value, since that is the only reason to call it', async () => {
    expect(reject({ description: 'label only' })[0]!.field).toBe('value');
  });
});

/**
 * The refusals are the point of this contract, and `.strict()` is what enforces them.
 *
 * Silently ignoring an unknown field would be worse than rejecting it: an admin who
 * sends `tier` and gets a `200` has every reason to believe the tier changed. The
 * difference between a refused change and a change someone believes they made is the
 * whole value of failing here.
 */
describe('fields this surface must never change', () => {
  /**
   * The one that matters most. CLAUDE.md: "A warning must never become a block — a
   * real 2,500 mL day is the data point the care team most needs." A tier flip would
   * suppress that signal with no code change and no release to notice it.
   */
  it('refuses a tier change outright', async () => {
    expect(reject({ value: 2000, tier: 'TIER_1_HARD_BLOCK' })).toEqual([
      { field: '', rule: 'unrecognized_keys' },
    ]);
  });

  it('refuses a key change, which would be a deletion in disguise', async () => {
    // `ThresholdsService` finds the row by key and throws when one is missing rather
    // than inventing a default, so a rename and a delete are indistinguishable.
    expect(reject({ value: 2000, thresholdKey: 'something_else' })[0]!.rule).toBe(
      'unrecognized_keys',
    );
  });

  it('refuses a unit change, which would silently redefine the value', async () => {
    // The key already names the unit, and no reader re-reads it — editing the unit
    // alone changes what the number means while every interpretation stays put.
    expect(reject({ value: 2000, unit: 'L' })[0]!.rule).toBe('unrecognized_keys');
  });

  it('refuses flipping the patient-adjustable safety flag', async () => {
    expect(reject({ value: 2000, patientAdjustable: true })[0]!.rule).toBe('unrecognized_keys');
  });
});

/**
 * The same `DECIMAL(12,4)` column shape as a value-set quantity, and the same two
 * failure modes CLAUDE.md records as already paid for once: an opaque 500 past `10^8`,
 * and a silent round past four decimal places.
 */
describe('the DECIMAL(12,4) column the value is stored in', () => {
  it('rejects a magnitude the column cannot hold', async () => {
    expect(reject({ value: MAX_REPRESENTABLE_VALUE_ML })[0]!.field).toBe('value');
  });

  it('rejects more precision than the column keeps, rather than rounding it', async () => {
    expect(reject({ value: 2000.00005 })[0]!.field).toBe('value');
  });

  it('accepts four decimal places', async () => {
    expect(updateThresholdSchema.safeParse({ value: 2000.0001 }).success).toBe(true);
  });
});

describe('the sign of a bound', () => {
  /**
   * `0` is meaningful for at least one row — `sync_clock_skew_allowance_seconds` of
   * zero means "allow no skew" — so this is non-negative rather than positive.
   */
  it('accepts zero', async () => {
    expect(updateThresholdSchema.safeParse({ value: 0 }).success).toBe(true);
  });

  it('rejects a negative bound, which no threshold can mean', async () => {
    // A soft warning at -1 warns on every entry a patient ever makes.
    expect(reject({ value: -1 })[0]!.field).toBe('value');
  });

  it('rejects a non-numeric value', async () => {
    expect(reject({ value: '2000' })[0]!.field).toBe('value');
  });
});

describe('the admin label', () => {
  it('rejects one longer than the column keeps', async () => {
    expect(reject({ value: 2000, description: 'x'.repeat(501) })[0]!.field).toBe('description');
  });

  /**
   * Empty string and absent are different on purpose: one clears the label, the other
   * leaves it alone, and the audit row shows which happened.
   */
  it('accepts an empty string, which is how a label is cleared', async () => {
    expect(updateThresholdSchema.safeParse({ value: 2000, description: '' }).success).toBe(true);
  });
});
