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
 * The admin value-set wire contract.
 *
 * A unit spec and not part of the integration suite, deliberately: that suite skips
 * itself when Docker is unreachable, and CLAUDE.md names that trap. Everything in
 * this file is a pure function of its input, so it runs everywhere and always — and
 * it covers the bound that keeps a mistyped quantity from reaching the column at all.
 */
import { MAX_REPRESENTABLE_VALUE_ML, MAX_VALUE_DECIMAL_PLACES } from '@ostomy/core/admin';
import { describe, expect, it } from 'vitest';

import { addValueSetMemberSchema, toNumericValue } from './admin-value-set-wire';

const VALID = { code: 'cup_250', sortOrder: 10, numericValue: 250, numericUnit: 'mL' };

function reject(body: unknown): { field: string; rule: string }[] {
  const parsed = addValueSetMemberSchema.safeParse(body);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error('unreachable');
  return parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), rule: issue.code }));
}

describe('a member this surface will accept', () => {
  it('accepts a quantity member', async () => {
    expect(addValueSetMemberSchema.safeParse(VALID).success).toBe(true);
  });

  it('accepts a category member, with neither value nor unit', async () => {
    const parsed = addValueSetMemberSchema.safeParse({
      ...VALID,
      numericValue: null,
      numericUnit: null,
    });
    expect(parsed.success).toBe(true);
  });
});

/**
 * The column is `DECIMAL(12,4)`, and `numericValue` is the clinical meaning of a code
 * that has no edit endpoint. Unbounded, Postgres silently rounded past four decimal
 * places and raised an unhandled overflow past `10^8` — the pair CLAUDE.md records as
 * already paid for once on the observations path, as HTTP 500s both times.
 */
describe('the DECIMAL(12,4) column the quantity is stored in', () => {
  it('rejects a magnitude the column cannot hold', async () => {
    expect(reject({ ...VALID, numericValue: MAX_REPRESENTABLE_VALUE_ML })).toEqual([
      { field: 'numericValue', rule: 'custom' },
    ]);
  });

  it('accepts the largest magnitude it can', async () => {
    const parsed = addValueSetMemberSchema.safeParse({
      ...VALID,
      numericValue: MAX_REPRESENTABLE_VALUE_ML - 1,
    });
    expect(parsed.success).toBe(true);
  });

  /**
   * The quieter half, and the worse one. A `201` for a value that is not what the
   * admin typed means the wrong figure then governs every entry made through that
   * button, with no edit endpoint to correct it.
   */
  it('rejects more precision than the column keeps, rather than rounding it', async () => {
    expect(reject({ ...VALID, numericValue: 250.00005 })).toEqual([
      { field: 'numericValue', rule: 'custom' },
    ]);
  });

  it('accepts exactly the precision it keeps', async () => {
    expect(MAX_VALUE_DECIMAL_PLACES).toBe(4);
    expect(addValueSetMemberSchema.safeParse({ ...VALID, numericValue: 250.0001 }).success).toBe(
      true,
    );
  });
});

describe('the value and its unit travel together', () => {
  /**
   * The rule the wire module calls a contract. It must NAME a field: as a top-level
   * `refine` it carried `path: []`, so the controller reported an empty field name and
   * the rule was unreportable.
   */
  it('rejects a value with no unit, naming the field', async () => {
    expect(reject({ ...VALID, numericUnit: null })).toEqual([
      { field: 'numericUnit', rule: 'custom' },
    ]);
  });

  it('rejects a unit with no value, naming the field', async () => {
    expect(reject({ ...VALID, numericValue: null })).toEqual([
      { field: 'numericUnit', rule: 'custom' },
    ]);
  });
});

describe('the code is permanent, so its shape is checked up front', () => {
  it('rejects a code that does not start with a letter', async () => {
    // `_`, `__` and all-digit codes are permanent once created, and none is a code
    // anyone would choose on purpose.
    expect(reject({ ...VALID, code: '_leading' })[0]!.field).toBe('code');
    expect(reject({ ...VALID, code: '250' })[0]!.field).toBe('code');
  });

  it('rejects uppercase and punctuation', async () => {
    expect(reject({ ...VALID, code: 'Cup_250' })[0]!.field).toBe('code');
    expect(reject({ ...VALID, code: 'cup-250' })[0]!.field).toBe('code');
  });

  it('rejects an empty code', async () => {
    expect(reject({ ...VALID, code: '' })[0]!.field).toBe('code');
  });
});

describe('unknown fields are refused, not ignored', () => {
  /**
   * `.strict()`. Silently dropping a field an admin sent would mean the console could
   * believe it set something it did not — and the reason code is what makes this
   * legible, because an unrecognised key reports no path at all.
   */
  it('rejects a field this contract does not define', async () => {
    expect(reject({ ...VALID, retiredAt: null })).toEqual([
      { field: '', rule: 'unrecognized_keys' },
    ]);
  });
});

describe('toNumericValue', () => {
  it('projects a Decimal to a JSON number', async () => {
    expect(toNumericValue({ toNumber: () => 250 })).toBe(250);
  });

  it('keeps null as null, never zero', async () => {
    // A missing quantity is not a quantity of zero — the same rule the voided-urine
    // volume follows (`docs/sync-contract.md` §7.2).
    expect(toNumericValue(null)).toBeNull();
  });
});
