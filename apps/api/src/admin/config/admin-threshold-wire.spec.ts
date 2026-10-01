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

import { ValidationTier } from '../../generated/prisma/enums';

import { THRESHOLD_TIERS, updateThresholdSchema } from './admin-threshold-wire';

function reject(body: unknown): { field: string; rule: string }[] {
  const parsed = updateThresholdSchema.safeParse(body);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error('unreachable');
  return parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), rule: issue.code }));
}

describe('the body is the complete state of the two mutable fields', () => {
  it('accepts a value and a label', async () => {
    expect(updateThresholdSchema.safeParse({ value: 1500, description: 'tightened' }).success).toBe(
      true,
    );
  });

  it('accepts null as the way to clear the label', async () => {
    expect(updateThresholdSchema.safeParse({ value: 1500, description: null }).success).toBe(true);
  });

  it('requires a value, since that is the only reason to call it', async () => {
    expect(reject({ description: 'label only' })[0]!.field).toBe('value');
  });

  /**
   * Required, not optional. Optional meant "absent leaves it alone", which is PATCH's
   * semantics — and because the column is nullable while the only sendable empty value
   * was `''`, it minted a second "no label" state the API could never return to NULL.
   */
  it('requires the label, so there is one empty representation and not two', async () => {
    expect(reject({ value: 1500 })[0]!.field).toBe('description');
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
    // `unrecognized_keys` carries `path: []`, so the issue itself names no field — the
    // controller expands `issue.keys` to recover it. Asserted here on the keys for the
    // same reason: the first version pinned `field: ''` and locked in a 400 that told
    // an admin nothing about which field was refused.
    const parsed = updateThresholdSchema.safeParse({
      value: 2000,
      description: null,
      tier: 'TIER_1_HARD_BLOCK',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('unreachable');
    const issue = parsed.error.issues[0]!;
    expect(issue.code).toBe('unrecognized_keys');
    expect('keys' in issue ? issue.keys : []).toEqual(['tier']);
  });

  it('refuses a key change, which would be a deletion in disguise', async () => {
    // `ThresholdsService` finds the row by key and throws when one is missing rather
    // than inventing a default, so a rename and a delete are indistinguishable.
    expect(
      reject({ value: 2000, description: null, thresholdKey: 'something_else' })[0]!.rule,
    ).toBe('unrecognized_keys');
  });

  it('refuses a unit change, which would silently redefine the value', async () => {
    // The key already names the unit, and no reader re-reads it — editing the unit
    // alone changes what the number means while every interpretation stays put.
    expect(reject({ value: 2000, description: null, unit: 'L' })[0]!.rule).toBe(
      'unrecognized_keys',
    );
  });

  it('refuses flipping the patient-adjustable safety flag', async () => {
    expect(reject({ value: 2000, description: null, patientAdjustable: true })[0]!.rule).toBe(
      'unrecognized_keys',
    );
  });
});

/**
 * The same `DECIMAL(12,4)` column shape as a value-set quantity, and the same two
 * failure modes CLAUDE.md records as already paid for once: an opaque 500 past `10^8`,
 * and a silent round past four decimal places.
 */
describe('the DECIMAL(12,4) column the value is stored in', () => {
  it('rejects a magnitude the column cannot hold', async () => {
    expect(reject({ value: MAX_REPRESENTABLE_VALUE_ML, description: null })[0]!.field).toBe(
      'value',
    );
  });

  it('rejects more precision than the column keeps, rather than rounding it', async () => {
    expect(reject({ value: 2000.00005, description: null })[0]!.field).toBe('value');
  });

  it('accepts four decimal places', async () => {
    expect(updateThresholdSchema.safeParse({ value: 2000.0001, description: null }).success).toBe(
      true,
    );
  });
});

describe('the sign of a bound', () => {
  /**
   * The assertion that replaced "accepts zero", which was the blocking finding of PR
   * B's review and the most consequential thing I got wrong in it.
   *
   * `sync_clock_skew_allowance_seconds` becomes `maxClockSkewMs`, and `packages/core`'s
   * own test asserts that `maxClockSkewMs: 0` turns a timestamp 30 seconds in the
   * future from `pass` into `blocked` — a Tier 1 hard block with no override. So `0`
   * there rejects every queued entry from every patient whose phone clock runs a second
   * fast, into a correction inbox describing a problem they cannot fix. The original
   * comment cited that exact key as the REASON to permit zero.
   */
  it('rejects zero, which on the clock-skew row is a Tier 1 block on every fast clock', async () => {
    expect(reject({ value: 0, description: null })[0]!.field).toBe('value');
  });

  it('rejects a negative bound, which no threshold can mean', async () => {
    // A soft warning at -1 warns on every entry a patient ever makes.
    expect(reject({ value: -1, description: null })[0]!.field).toBe('value');
  });

  it('accepts the smallest positive value', async () => {
    expect(updateThresholdSchema.safeParse({ value: 0.0001, description: null }).success).toBe(
      true,
    );
  });

  it('rejects a non-numeric value', async () => {
    expect(reject({ value: '2000', description: null })[0]!.field).toBe('value');
  });
});

/**
 * The wire set is a deliberate mirror of the database enum rather than an import — see
 * the module comment for why. `toSnapshot`'s parameter type makes a divergence a
 * compile error today, but that guard evaporates the moment someone "simplifies"
 * `ThresholdRow.tier` to `string`, and it would surface as an assignability error on an
 * unrelated line rather than "you added a tier and did not publish it".
 *
 * If a tier is ever added and deliberately NOT published, list it here with the reason
 * rather than deleting this test.
 */
describe('the published tier set', () => {
  it('matches the database enum', async () => {
    expect([...THRESHOLD_TIERS].sort()).toEqual(Object.values(ValidationTier).sort());
  });
});

describe('the admin label', () => {
  /**
   * A wire policy, not the column's shape — `description` is `TEXT` and keeps any
   * length. The cap exists because the label is copied into the audit row's
   * before/after JSON, on a table with no DELETE grant anywhere: an unbounded admin
   * string there is unbounded forever.
   */
  it('rejects one long enough to be unbounded in an append-only table', async () => {
    expect(reject({ value: 2000, description: 'x'.repeat(501) })[0]!.field).toBe('description');
  });

  it('accepts an empty string, though null is the way to clear it', async () => {
    expect(updateThresholdSchema.safeParse({ value: 2000, description: '' }).success).toBe(true);
  });
});
