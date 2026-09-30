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

import { z } from 'zod';

/**
 * The wire contract for the admin value-set surface (P3.S3, ADR-0008).
 *
 * Separate from `thresholds/value-sets-openapi.ts`, which describes what a
 * PATIENT client reads. The two must not be merged: that one publishes a fixed
 * list of sets with retired members omitted, this one is the whole table with
 * retirement visible, and collapsing them would put an admin surface inside a
 * module the patient client's generator walks.
 */

/** A value-set key, e.g. `fluid_type`. */
export const VALUE_SET_KEY_MAX_LENGTH = 64;

/**
 * A member code. Stable and permanent: clinical records reference it, so it is
 * the one field nothing may ever rewrite.
 */
export const VALUE_SET_MEMBER_CODE_MAX_LENGTH = 64;

/**
 * Deliberately NOT a general "update member" schema.
 *
 * `numericValue` is the clinical meaning of a code — `container_size` `cup_250`
 * means 250 mL — and CLAUDE.md's rule is absolute: *no admin action may change
 * what a past entry means*. An observation that stored `cup_250` in March is
 * read back through whatever that member says today, so editing 250 to 400
 * silently rewrites history in every stored entry, with nothing detecting it.
 *
 * The correct operation is therefore retire-and-add, which leaves the old code
 * resolving to the old meaning for the records that used it. That is why this
 * module exposes a create and a retire and no update. If a genuine typo has to
 * be corrected, it is a migration with a data audit, not an API call.
 *
 * `sortOrder` is the exception in principle — it is presentation only — but a
 * reorder endpoint is not built here, because nothing needs one yet and the
 * smallest surface that satisfies ADR-0008 is the one to build at "final shape".
 */
export const addValueSetMemberSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(VALUE_SET_MEMBER_CODE_MAX_LENGTH)
      .regex(/^[a-z0-9_]+$/)
      .meta({
        description:
          'The stable code clinical records will reference. Lower snake case. Permanent once created: retiring it is the only way to withdraw it, because stored entries resolve their meaning through it.',
      }),
    sortOrder: z.number().int().min(0).max(9999).meta({
      description:
        'Presentation order within the set. The only field a later change may safely touch.',
    }),
    numericValue: z.number().nullable().meta({
      description:
        'The quantity this code carries, for sets whose members are quantities (a container size). Null for a category. Immutable in effect: an entry stored against this code is read back through this value, so changing it would rewrite what past entries mean.',
    }),
    numericUnit: z.string().min(1).max(32).nullable().meta({
      description:
        'The unit numericValue is in, stored beside it rather than assumed from the set. Travels with numericValue: both present or both null.',
    }),
  })
  .strict()
  .refine(
    (value) => (value.numericValue === null) === (value.numericUnit === null),
    // A value with no unit is one a reader has to guess about, and a unit with no
    // value is meaningless. The patient-facing projection carries both or neither,
    // so accepting a half-populated pair here would put a row on the wire that the
    // read model cannot describe.
    { message: 'numericValue and numericUnit must both be present or both be null' },
  );

export type AddValueSetMemberRequest = z.infer<typeof addValueSetMemberSchema>;

/** One member as the admin surface reports it — including retired ones. */
export const adminValueSetMemberSchema = z.object({
  code: z.string(),
  sortOrder: z.number().int(),
  numericValue: z.number().nullable(),
  numericUnit: z.string().nullable(),
  /**
   * Visible here and invisible to patients, on purpose. A patient client infers
   * retirement from ABSENCE (CLAUDE.md, P3.S1) — which is why its cache does a
   * delete-then-insert per set rather than an upsert. An admin reviewing history
   * needs the opposite: to see that a code exists, is withdrawn, and still
   * resolves for the records that used it.
   */
  status: z.enum(['ACTIVE', 'RETIRED']),
});

export const adminValueSetSchema = z.object({
  key: z.string(),
  members: z.array(adminValueSetMemberSchema),
});

export const adminValueSetsResponseSchema = z.object({
  valueSets: z.array(adminValueSetSchema),
});

export type AdminValueSetsResponse = z.infer<typeof adminValueSetsResponseSchema>;
export type AdminValueSetMember = z.infer<typeof adminValueSetMemberSchema>;

/**
 * What an audit row records for a value-set member change.
 *
 * Named field by field rather than spreading the Prisma row, for the reason
 * `packages/core`'s sync constructors exist: a spread typechecks cleanly and
 * ships whatever the model grows next into an append-only table that cannot be
 * corrected afterwards.
 */
export interface ValueSetMemberSnapshot {
  readonly valueSetKey: string;
  readonly code: string;
  readonly sortOrder: number;
  readonly numericValue: number | null;
  readonly numericUnit: string | null;
  readonly status: 'ACTIVE' | 'RETIRED';
}
