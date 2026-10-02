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
 * The mapping had three hand-rolled copies and no test anywhere, which is how
 * #100 happened: two of the three dropped the field name for an ordinary typo.
 * These parse real bodies through real schemas rather than constructing
 * `ZodError`s by hand, because the bug was in what Zod actually emits for
 * `unrecognized_keys` (`path: []`, with the keys on the issue), not in the
 * mapping of an imagined issue.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ROOT_FIELD, UNRECOGNIZED_FIELD, toAdminErrorFields } from './wire-errors';

const IMMUTABLE = ['tier', 'thresholdKey'] as const;

const schema = z
  .object({
    value: z.number().gt(0),
    description: z.string().nullable(),
  })
  .strict();

/** Fields for a body this schema refuses. Throws if the body is accepted. */
function fieldsFor(body: unknown, immutable: readonly string[] = IMMUTABLE) {
  const parsed = schema.safeParse(body);
  if (parsed.success) throw new Error('expected the schema to refuse this body');
  return toAdminErrorFields(parsed.error, immutable);
}

describe('toAdminErrorFields', () => {
  it('names an ordinary field failure with its rule code', () => {
    expect(fieldsFor({ value: -1, description: null })).toEqual([
      { field: 'value', rule: 'too_small' },
    ]);
  });

  it('names every failing field, not just the first', () => {
    const fields = fieldsFor({ value: -1, description: 7 });
    expect(fields.map((entry) => entry.field).sort()).toEqual(['description', 'value']);
  });

  /**
   * The #100 defect. An unknown key that is NOT an immutable field is the
   * commonest reason to get a 400 here — a typo — and two of the three copies
   * answered with an empty field list or an empty field name.
   */
  it('names an unknown key rather than dropping it', () => {
    const fields = fieldsFor({ value: 1, description: null, bogus: 1 });

    expect(fields).toEqual([{ field: UNRECOGNIZED_FIELD, rule: 'unrecognized_field' }]);
    expect(fields).not.toHaveLength(0);
  });

  it('distinguishes an immutable field from an unknown one', () => {
    // Different answers because they are different mistakes: an admin sending
    // `tier` has a mistaken model of the surface, not a typo.
    const fields = fieldsFor({ value: 1, description: null, tier: 'TIER_1_HARD_BLOCK' });

    expect(fields).toEqual([{ field: 'tier', rule: 'immutable_field' }]);
  });

  it('reports a mix of immutable and unknown keys in one body', () => {
    const fields = fieldsFor({ value: 1, description: null, tier: 'x', bogus: 1 });

    expect(fields).toContainEqual({ field: 'tier', rule: 'immutable_field' });
    expect(fields).toContainEqual({ field: UNRECOGNIZED_FIELD, rule: 'unrecognized_field' });
  });

  it('keeps one entry per unknown key, so the count still means something', () => {
    const fields = fieldsFor({ value: 1, description: null, a: 1, b: 2, c: 3 });

    expect(fields).toHaveLength(3);
  });

  it('names a root-level problem rather than reporting an empty field', () => {
    // A body that is not an object at all carries `path: []`, which joined is
    // the empty string.
    expect(fieldsFor('not an object')).toEqual([{ field: ROOT_FIELD, rule: 'invalid_type' }]);
  });

  /**
   * The constraint that outranks usefulness here, from CLAUDE.md: a validation
   * error returns field identifiers and rule codes and **never the offending
   * clinical value**. Asserted over a body whose every value is distinctive, so
   * a future change that started echoing `message` — which quotes input — fails
   * here rather than in review.
   */
  it('never echoes a value, a message, or a caller-supplied key', () => {
    const fields = fieldsFor({
      value: -4242.4242,
      description: 'SENTINEL_DESCRIPTION',
      SENTINEL_KEY: 'SENTINEL_VALUE',
    });

    const serialised = JSON.stringify(fields);
    for (const secret of [
      '4242',
      'SENTINEL_DESCRIPTION',
      'SENTINEL_KEY',
      'SENTINEL_VALUE',
      'message',
    ]) {
      expect(serialised, secret).not.toContain(secret);
    }
  });

  it('treats an empty immutable list as "every unknown key is unrecognised"', () => {
    // The default, for a surface with no immutable fields of its own.
    expect(fieldsFor({ value: 1, description: null, tier: 'x' }, [])).toEqual([
      { field: UNRECOGNIZED_FIELD, rule: 'unrecognized_field' },
    ]);
  });
});
