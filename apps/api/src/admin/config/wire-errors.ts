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

import type { z } from 'zod';

/**
 * One Zod error, turned into the `fields` array every admin 400 carries.
 *
 * ## Why this is shared rather than written three times
 *
 * It was written three times, and all three were different — which is #100.
 * Each copy had its own defect, and none had a test:
 *
 * - **thresholds** expanded `unrecognized_keys` but intersected the keys with
 *   `IMMUTABLE_FIELDS` and **dropped the remainder**, so a body carrying an
 *   unknown key that is not an immutable field — `{value, description, bogus}`,
 *   i.e. an ordinary typo — produced `fields: []`. A 400 naming nothing, for the
 *   commonest reason to get one.
 * - **value-sets** never expanded `unrecognized_keys` at all, so any unknown key
 *   reported `field: ''`, because that issue carries `path: []`.
 * - **default-ranges** was corrected during #96's review and is the shape this
 *   function generalises.
 *
 * The lesson is the duplication, not the three bugs: the same mapping in three
 * places drifted three ways, and the only copy that got reviewed closely was the
 * only one that was right. So there is now one implementation, with its own spec.
 *
 * ## What it may and may not say
 *
 * Field identifiers and rule codes, **never the offending value** (CLAUDE.md,
 * "Validation"). Zod's `message` is dropped on purpose: it can quote the input.
 * Zod's issue codes are a closed vocabulary and leak nothing.
 *
 * Nothing of the caller's input is echoed either. An unrecognised key is
 * reported as a fixed sentinel rather than by name, so a caller cannot get an
 * arbitrary string reflected back by sending it as a key — which matters because
 * a console renders these.
 */
export interface AdminErrorField {
  readonly field: string;
  readonly rule: string;
}

/**
 * Reported in place of an unknown key's name, so nothing of the caller's input
 * is echoed.
 *
 * A literal rather than the empty string, which is what `default-ranges` used.
 * `''` collides with the root-level case below once anything renders these: a
 * consumer doing `field || '(body)'` — `scripts/admin-config.mjs` does exactly
 * that — turns "you sent a key I do not know" into "the body itself is wrong",
 * which sends the reader to the wrong place. Changing it is a visible difference
 * in that one surface's 400 body, and the better of the two readings.
 */
export const UNRECOGNIZED_FIELD = '(unrecognized)';

/**
 * Reported when an issue carries no path at all — a body that is an array, a
 * string, or null. Named rather than left as the empty string, for the same
 * reason.
 */
export const ROOT_FIELD = '(body)';

/**
 * `immutableFields` is the closed list this surface refuses to let change. A key
 * in it is reported as `immutable_field`, because "you may not change this" is a
 * different and more useful answer than "I do not know this key" — an admin who
 * sends `tier` has a mistaken model, not a typo.
 *
 * Anything else is `unrecognized_field`. One entry per key rather than one
 * de-duplicated entry, so the count still conveys how many keys were wrong.
 */
export function toAdminErrorFields(
  error: z.ZodError,
  immutableFields: readonly string[] = [],
): AdminErrorField[] {
  return error.issues.flatMap((issue) => {
    if (issue.code === 'unrecognized_keys') {
      return issue.keys.map((key) =>
        immutableFields.includes(key)
          ? { field: key, rule: 'immutable_field' }
          : { field: UNRECOGNIZED_FIELD, rule: 'unrecognized_field' },
      );
    }
    return [{ field: issue.path.join('.') || ROOT_FIELD, rule: issue.code }];
  });
}
