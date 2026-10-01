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

import {
  MAX_REPRESENTABLE_VALUE_ML,
  MAX_VALUE_DECIMAL_PLACES,
  exceedsMaxMagnitude,
  exceedsMaxPrecision,
} from '@ostomy/core/admin';
import { z } from 'zod';

/**
 * The wire contract for the admin clinical-default-range surface (P3.S3 PR C,
 * ADR-0008).
 *
 * ## Why this surface has a create, where the other two do not
 *
 * `clinical_default_ranges` is created by the init migration and **never seeded**, and
 * nothing reads it yet — §3.9's suggestion seeding is P6/P7. So unlike
 * `validation_thresholds`, where every environment needs rows because
 * `ThresholdsService` throws without them, this table is empty by design and will stay
 * empty unless something can put rows in it. A surface with no create would leave
 * §3.9 with nothing to seed from and no route to fix that short of a migration.
 *
 * That also means this is the one admin surface whose consumer does not exist yet.
 * ADR-0008 is explicit that the configuration tables and their API come early and the
 * console comes at P8, so building ahead of the reader is the plan rather than a
 * mistake — but it is worth saying out loud, because nothing here is exercised by a
 * clinical path today and a reviewer should not assume otherwise.
 *
 * ## The hazard this table has and the other two do not
 *
 * There is **no unique constraint** — only `@@index([ostomyType, rangeType])` — and
 * that is correct, because many rows share a type pair and are distinguished by their
 * post-operative day window. The consequence is that two rows can cover overlapping
 * windows: `ILEOSTOMY`/`daily_output_ml` for days 0–30 and days 15–60 both match a
 * patient on day 20, and §3.9 would then seed from whichever the query happened to
 * return. That is a silent, retrospective ambiguity in a clinical default, and it is
 * this surface's equivalent of a tier flip: nothing errors, and the wrong guidance is
 * indistinguishable from the right one afterwards.
 *
 * So overlap is refused. The window arithmetic lives here; the check against existing
 * rows has to be in the service, which is where the other rows are.
 *
 * ## What may change on an existing row
 *
 * `lowValue`, `highValue` and `windowDays` — the parameters of the rule. Not
 * `ostomyType`, `rangeType` or the day window: those three together are *which*
 * default this is, so editing one turns the row into a different default rather than
 * correcting this one. Same argument as `thresholdKey`. A mistake there is a delete
 * and a create, which this surface supports precisely because nothing references these
 * rows by identity.
 *
 * Not `unit` either, for the reason the threshold surface gives: the `rangeType`
 * already names it (`daily_output_ml`, `weight_change_threshold_percent`,
 * `resting_heart_rate_elevation_bpm`), and editing it alone redefines every value in
 * the row while every reader's interpretation stays put.
 *
 * ## Why delete is allowed here and not on a value-set member
 *
 * A member code is referenced by stored clinical records, so deleting one makes a
 * patient's history unreadable. A default range is not referenced by anything:
 * `effective_ranges` carries its own `lowValue`/`highValue` with a `provenance` of
 * `CLINICAL_DEFAULT`, which is a **copy** and not a pointer — there is no foreign key
 * from it to this table. Deleting a default therefore cannot alter a range any patient
 * already has. Combined with the overlap rule, which makes a wrong row something that
 * must be removable rather than merely editable, delete is the right affordance.
 */

/** Matches `OstomyType` in the Prisma schema. v1 is colostomy and ileostomy only (SRS Appendix A). */
export const OSTOMY_TYPES = ['COLOSTOMY', 'ILEOSTOMY'] as const;
export type AdminOstomyType = (typeof OSTOMY_TYPES)[number];

export const RANGE_TYPE_MAX_LENGTH = 64;
export const RANGE_UNIT_MAX_LENGTH = 32;
/**
 * A sanity ceiling on the post-operative window, not a clinical bound.
 *
 * Roughly thirty years in days. It exists so a typo cannot create a window that
 * overlaps every future row for the same type pair and silently wins every match —
 * the overlap rule is only as useful as the windows being plausible.
 */
export const MAX_DAYS_POST_OP = 11_000;

const decimalBound = (field: string) =>
  z
    .number()
    .refine((value) => !exceedsMaxMagnitude(value), {
      error: `${field} must be smaller than ${String(MAX_REPRESENTABLE_VALUE_ML)}`,
    })
    .refine((value) => !exceedsMaxPrecision(value), {
      error: `${field} must have at most ${String(MAX_VALUE_DECIMAL_PLACES)} decimal places`,
    });

/**
 * The fields that define a rule, shared by create and update.
 *
 * `lowValue` and `highValue` are both nullable because a range legitimately has one
 * side: a daily-output ceiling has no floor, and an adequacy bound has no top. What is
 * not legitimate is neither — a row with no bound at all states nothing and would seed
 * a suggestion of nothing.
 */
const ruleFields = {
  lowValue: decimalBound('lowValue').nullable().meta({
    description: 'The bottom of the range, or null where the rule has no floor.',
  }),
  highValue: decimalBound('highValue').nullable().meta({
    description: 'The top of the range, or null where the rule has no ceiling.',
  }),
  windowDays: z.number().int().positive().max(365).nullable().meta({
    description:
      'Rolling-window length for a windowed rule (a weight or heart-rate baseline). Null where the rule is a flat bound.',
  }),
};

/** Both bounds cannot be absent, and a floor above a ceiling is not a range. */
function checkBounds(
  value: { lowValue: number | null; highValue: number | null },
  ctx: z.RefinementCtx,
): void {
  if (value.lowValue === null && value.highValue === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['lowValue'],
      message: 'a range must have a lowValue, a highValue, or both',
    });
  }
  if (value.lowValue !== null && value.highValue !== null && value.lowValue > value.highValue) {
    ctx.addIssue({
      code: 'custom',
      path: ['highValue'],
      message: 'highValue must not be below lowValue',
    });
  }
}

/** An inclusive post-operative day window. `null` max means "and beyond". */
function checkWindow(
  value: { minDaysPostOp: number | null; maxDaysPostOp: number | null },
  ctx: z.RefinementCtx,
): void {
  if (
    value.minDaysPostOp !== null &&
    value.maxDaysPostOp !== null &&
    value.minDaysPostOp > value.maxDaysPostOp
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['maxDaysPostOp'],
      message: 'maxDaysPostOp must not be before minDaysPostOp',
    });
  }
}

export const createDefaultRangeSchema = z
  .object({
    ostomyType: z.enum(OSTOMY_TYPES).meta({
      description:
        'Which ostomy this default applies to. Permanent: it is part of which default this is.',
    }),
    rangeType: z
      .string()
      .min(1)
      .max(RANGE_TYPE_MAX_LENGTH)
      .regex(/^[a-z][a-z0-9_]*$/)
      .meta({
        description:
          'What the range governs, e.g. daily_output_ml. Shares a key space with EffectiveRange.rangeType, and names the unit. Permanent.',
      }),
    minDaysPostOp: z.number().int().min(0).max(MAX_DAYS_POST_OP).nullable().meta({
      description:
        'First post-operative day this default applies to, inclusive. Null means from surgery.',
    }),
    maxDaysPostOp: z.number().int().min(0).max(MAX_DAYS_POST_OP).nullable().meta({
      description: 'Last post-operative day, inclusive. Null means unbounded — "and beyond".',
    }),
    unit: z.string().min(1).max(RANGE_UNIT_MAX_LENGTH).meta({
      description:
        'The unit both bounds are in. Permanent, because the rangeType already names it and editing it alone would redefine every value in the row.',
    }),
    ...ruleFields,
  })
  .strict()
  .superRefine((value, ctx) => {
    checkBounds(value, ctx);
    checkWindow(value, ctx);
  });

export type CreateDefaultRangeRequest = z.infer<typeof createDefaultRangeSchema>;

/**
 * Only the rule's parameters. The identity fields are absent and must stay absent —
 * see the module comment.
 */
export const updateDefaultRangeSchema = z
  .object(ruleFields)
  .strict()
  .superRefine((value, ctx) => {
    checkBounds(value, ctx);
  });

export type UpdateDefaultRangeRequest = z.infer<typeof updateDefaultRangeSchema>;

export const adminDefaultRangeSchema = z.object({
  id: z.uuid(),
  ostomyType: z.enum(OSTOMY_TYPES),
  rangeType: z.string(),
  minDaysPostOp: z.number().int().nullable(),
  maxDaysPostOp: z.number().int().nullable(),
  lowValue: z.number().nullable(),
  highValue: z.number().nullable(),
  unit: z.string(),
  windowDays: z.number().int().nullable(),
  updatedAt: z.iso.datetime(),
});

export const adminDefaultRangesResponseSchema = z.object({
  defaultRanges: z.array(adminDefaultRangeSchema),
});

export type AdminDefaultRange = z.infer<typeof adminDefaultRangeSchema>;
export type AdminDefaultRangesResponse = z.infer<typeof adminDefaultRangesResponseSchema>;

/**
 * What an audit row records for a default-range change.
 *
 * Carries the identity fields as well as the rule, for the reason the threshold
 * snapshot does: a reader a year later must be able to tell what the numbers MEANT
 * without joining back to a table that may have been migrated. `1200 -> 1400` says
 * nothing about which ostomy, which post-operative window, or what unit.
 */
export interface DefaultRangeSnapshot {
  readonly ostomyType: AdminOstomyType;
  readonly rangeType: string;
  readonly minDaysPostOp: number | null;
  readonly maxDaysPostOp: number | null;
  readonly lowValue: number | null;
  readonly highValue: number | null;
  readonly unit: string;
  readonly windowDays: number | null;
}

/**
 * Whether two inclusive post-operative day windows overlap at any day.
 *
 * `null` is an open end: a null minimum starts at surgery, a null maximum runs
 * forever. Exported and pure so the arithmetic is testable without a database — the
 * service supplies the other rows, but getting this wrong is how two defaults come to
 * match the same patient.
 */
export function windowsOverlap(
  a: { minDaysPostOp: number | null; maxDaysPostOp: number | null },
  b: { minDaysPostOp: number | null; maxDaysPostOp: number | null },
): boolean {
  const aStart = a.minDaysPostOp ?? 0;
  const bStart = b.minDaysPostOp ?? 0;
  // `Infinity` rather than a sentinel day number: an unbounded window really does run
  // forever, and a large-but-finite stand-in would make two unbounded windows look
  // non-overlapping past it.
  const aEnd = a.maxDaysPostOp ?? Number.POSITIVE_INFINITY;
  const bEnd = b.maxDaysPostOp ?? Number.POSITIVE_INFINITY;
  // Inclusive on both ends, so touching at a single day is an overlap: a patient on
  // day 30 would match both `0–30` and `30–60`.
  return aStart <= bEnd && bStart <= aEnd;
}
