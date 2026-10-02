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
 * So overlap is refused — by this surface and, since #97, by the table. An
 * `EXCLUDE USING gist` constraint makes an overlapping pair unrepresentable for any
 * writer, which is what the paragraph above needed and did not have: the ambiguity it
 * describes was reachable by a migration, `packages/seed` or a psql session, and one
 * shape of it was invisible to the check below afterwards (an inverted window, which
 * `windowsOverlap` reports as overlapping nothing).
 *
 * The window arithmetic still lives here and the sibling read still lives in the
 * service, and both are still worth having: the service's advisory lock and explicit
 * check are what turn a race into a `409` naming the rule, where the constraint alone
 * gives a Postgres violation someone has to interpret. The constraint guarantees, the
 * check explains.
 *
 * ## What may change on an existing row
 *
 * `lowValue` and `highValue` — the bounds, and nothing else. `ostomyType`,
 * `rangeType`, the day window and `windowDays` together are *which* default this is,
 * so editing one turns the row into a different default rather than correcting this
 * one. Same argument as `thresholdKey`. A mistake there is a delete and a create,
 * which this surface supports precisely because nothing references these rows by
 * identity.
 *
 * **`windowDays` was mutable and excluded from the overlap scope, which was
 * incoherent** (PR C review). SRS §3.12 has the admin managing "the weight-change
 * percentage thresholds **and rolling-window definitions**", plural — so a
 * 5%-over-7-days rule and a 10%-over-30-days rule for the same ostomy type and the
 * same post-operative window is ordinary configuration, and the overlap rule
 * *refused the second one*. Meanwhile an admin could edit a window length with no
 * uniqueness recheck, so the field was a rule parameter for mutation and part of the
 * row's meaning for nothing.
 *
 * Making it identity resolves both: multiple rolling windows per `rangeType` coexist,
 * and the overlap rule means "no two rows of the same shape match one patient". The
 * alternative — letting `rangeType` name the window, as it names the unit — would
 * make the column vestigial, which is the worse answer for a column §3.12 asks for by
 * name.
 *
 * Not `unit` either, for the reason the threshold surface gives: editing it alone
 * redefines every value in the row while every reader's interpretation stays put.
 * Unlike the threshold surface, this table can hold several rows per `rangeType`, so
 * "the key names the unit" is an invariant ACROSS rows rather than a property of one —
 * and the service enforces it, because resting the immutability argument on something
 * unenforced is how §3.9's reader comes to trust it wrongly.
 *
 * One gap this surface cannot close: `rangeType` is free text, and AC 14.1 AC1 wants a
 * plain-language basis for the suggestion seeded from these rows. Copy is i18n-keyed
 * (ADR-0006), so an admin-invented `rangeType` has no key — the same reachable state
 * CLAUDE.md records for an admin-added value-set member, which renders as "Another
 * option". Named here so §3.9's consumer decides it deliberately.
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
 *
 * **That argument is conditional, and the condition expires.** What is verifiable
 * today is that the delete is safe *while nothing reads this table*. Once §3.9's
 * seeding lands (P6/P7) two things change: `DELETE` becomes the only operation in the
 * system that can switch off a safety prompt, once the red-flag bound lives here
 * (#94); and because `ostomyType` is NOT NULL, a population-wide bound needs one row
 * per ostomy type, so deleting one leaves half the population with no bound and
 * nothing detects the asymmetry. Settled by #98 (superseded, kept so the change is visible): whichever sprint builds the seeding must revisit
 * whether a safety-class row may be deleted at all. Recorded here rather than left to
 * go stale, because the claim reads as unconditional and will not announce its own
 * expiry.
 *
 * There is also no restore path: the audit `beforeValue` holds the content, and
 * recovering it means a human reading JSON out of `audit_events` and retyping it.
 */

/** Matches `OstomyType` in the Prisma schema. v1 is colostomy and ileostomy only (SRS Appendix A). */
export const OSTOMY_TYPES = ['COLOSTOMY', 'ILEOSTOMY'] as const;
export type AdminOstomyType = (typeof OSTOMY_TYPES)[number];

export const RANGE_TYPE_MAX_LENGTH = 64;
export const RANGE_UNIT_MAX_LENGTH = 32;
/**
 * A sanity ceiling on the post-operative window, not a clinical bound.
 *
 * Roughly thirty years in days. Its job is keeping the integer in a plausible domain,
 * nothing more — the first version of this comment claimed it stopped a typo
 * "silently winning every match", which is wrong twice: `maxDaysPostOp: null` is an
 * explicitly supported unbounded window, and the overlap rule is what prevents a
 * silent win.
 */
export const MAX_DAYS_POST_OP = 11_000;

/** A rolling window longer than a year is a typo rather than a baseline. */
export const MAX_WINDOW_DAYS = 365;

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
  /**
   * Negative bounds are accepted, deliberately, and this is the one place that is
   * easy to "harmonise" away. `net_fluid_balance_ml` and
   * `weight_change_threshold_percent` legitimately have negative floors, so this
   * surface does NOT reuse Tier 1's positive-value rule — which exists for entered
   * volumes, where zero and below are structurally impossible. A test pins it.
   */
  lowValue: decimalBound('lowValue').nullable().meta({
    description: 'The bottom of the range, or null where the rule has no floor. May be negative.',
  }),
  highValue: decimalBound('highValue').nullable().meta({
    description: 'The top of the range, or null where the rule has no ceiling. May be negative.',
  }),
};

/** Part of the row identity — see the module comment. Create-only. */
const windowDaysField = z.number().int().positive().max(MAX_WINDOW_DAYS).nullable().meta({
  description:
    'Rolling-window length for a windowed rule (a weight or heart-rate baseline). Null where the rule is a flat bound. Part of the row identity: two rules for one rangeType are told apart by it, so it cannot be edited.',
});

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
    // Still accepted on the wire, and now checked against the limits row rather
    // than against whatever a sibling happened to say (#102). Kept on the
    // request because a body that states its own unit is self-describing in an
    // audit snapshot, and because silently substituting one would hide a
    // caller's mistaken model of the type.
    unit: z.string().min(1).max(RANGE_UNIT_MAX_LENGTH).meta({
      description:
        'The unit both bounds are in. Permanent: editing it alone would redefine every value in the row. Must match the unit its clinical_default_range_limits row declares (#102), which replaced a cross-row comparison that agreed with whatever the first row of a type happened to say.',
    }),
    windowDays: windowDaysField,
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

/**
 * The fields that define *which* default a row is, derived rather than listed.
 *
 * Derived from the two schemas so that adding a create-only field automatically makes
 * it identity — and automatically makes the update surface refuse it. A hardcoded list
 * would leave a new field silently mutable, which is the mechanism by which
 * `windowDays` came to be both.
 */
export const IDENTITY_FIELDS: readonly string[] = Object.keys(
  createDefaultRangeSchema.def.shape,
).filter((field) => !Object.keys(updateDefaultRangeSchema.def.shape).includes(field));

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

/**
 * What a range type permits, published alongside the rows (#102).
 *
 * Returned because the refusal is the backstop and SEEING the range is what
 * prevents the mistake — the 400 deliberately names only the field and a rule
 * code, never the numbers, so a caller that wants them has to be given them
 * here. The same reasoning as #93's settable range on a threshold.
 *
 * `basis` is deliberately NOT published. It is the migration's reasoning for a
 * reader of the schema, often a paragraph, and an API response is the wrong
 * place for it — a console would have to render prose it cannot lay out, and
 * the text names open issues.
 */
export const adminRangeTypeLimitsSchema = z.object({
  rangeType: z.string(),
  minValue: z.number(),
  maxValue: z.number(),
  unit: z.string(),
});

export type AdminRangeTypeLimits = z.infer<typeof adminRangeTypeLimitsSchema>;

export const adminDefaultRangesResponseSchema = z.object({
  defaultRanges: z.array(adminDefaultRangeSchema),
  /**
   * Every known range type, not just the ones with rows — the table starts
   * empty, so a console with nothing to list still needs to know what it may
   * create and within what bounds.
   */
  rangeTypeLimits: z.array(adminRangeTypeLimitsSchema),
});

/**
 * What a DELETE returns: the row as it was, plus its id, and no `updatedAt`.
 *
 * Declared rather than reusing `adminDefaultRangeSchema`, which was the bug both
 * reviews caught: the route advertised that schema — `id` and `updatedAt` both
 * required, `additionalProperties: false` — while the handler returned neither. The
 * published document is the only contract this surface has, and a P8 console generated
 * from it would read `undefined` off a required field. `updatedAt` is genuinely absent
 * rather than omitted for convenience: a row that no longer exists has no last-modified
 * time, and the id is what lets a console reconcile which row went.
 */
export const deletedDefaultRangeSchema = adminDefaultRangeSchema.omit({ updatedAt: true });

export type DeletedDefaultRange = z.infer<typeof deletedDefaultRangeSchema>;

export type AdminDefaultRange = z.infer<typeof adminDefaultRangeSchema>;

/**
 * Range types that must never seed an `effective_ranges` row.
 *
 * Consumed by nothing yet — §3.9's seeding is P6/P7 — and that is exactly why it
 * exists. #94 settled that the heart-rate red-flag bound lives in this table and that
 * "not patient-adjustable" has to be structural here, because the table has no
 * `patient_adjustable` column: the row exists and nothing derives a patient range from
 * it. The exclusion that enforces it will be keyed on a literal, and until now that
 * literal appeared nowhere in code — only in two prose comments in `schema.prisma`. An
 * implementer greps, finds comments, retypes the string, and a typo means the exclusion
 * silently does not fire and a patient gets an adjustable red-flag bound.
 *
 * Nothing in this surface branches on it, deliberately: the safety property belongs to
 * the seeder, and enforcing something here would imply it is enforced where the risk
 * actually lives.
 */
export const SAFETY_RANGE_TYPES = ['heart_rate_red_flag_bpm'] as const;

/**
 * Whether a range type is a clinical safety response rather than a data-quality
 * bound.
 *
 * **This is the consumer the constant was missing.** PR C added
 * `SAFETY_RANGE_TYPES` and said in terms that "nothing in this surface branches
 * on it, deliberately: the safety property belongs to the seeder". #98 changed
 * that judgement for one operation, and the reason is narrow enough to state
 * exactly.
 *
 * `DELETE` is **not** the only operation that can switch off a safety prompt,
 * which is what review corrected — a `PUT` removing the ceiling did it too, and
 * never creating the row did it by default. All three routes are now closed:
 * the rows are seeded by migration, create and delete are refused here, and
 * `assertSafetyRowShape` requires a ceiling. What remains true is that DELETE is
 * the most *final* of them, which is why it is refused outright rather than
 * shaped. §3.13's red-flag bound is a seek-care prompt, not a validation
 * warning — there is no override path, no warning copy, and nothing in the app
 * reports that the prompt has stopped being reachable. Every other mutation on
 * this table changes a number; this one removes the row.
 *
 * **The first version of this comment overstated the case, in two ways review
 * caught.** It said "DELETE is the only operation in the system that can switch
 * off a safety prompt" — a `PUT` removing the ceiling did the same thing and
 * answered 200. And it rested on "a safety bound's window is population-wide
 * (day 0 onward)", which nothing enforced: `MAX_DAYS_POST_OP` is 11,000 and the
 * window check only orders the two ends, so a safety row covering nobody was
 * accepted — and then permanently unrecoverable, because the window is
 * immutable, the delete is refused, and the correctly-windowed replacement
 * overlaps.
 *
 * Both are now true rather than assumed: the rows are seeded by migration, this
 * surface refuses to create or delete one, and `assertSafetyRowShape` requires
 * a ceiling, refuses a floor, and refuses a rolling window. `PUT` of the
 * ceiling is the only mutation, which is also the ratification path for the
 * clinical bound (#102).
 *
 * The cost, stated so nobody is surprised: removing a genuinely unwanted safety
 * row now needs a migration. That is the right amount of friction for the only
 * row that can silence a seek-care prompt, and `ostomy_type` being NOT NULL
 * makes it worse than it looks — a population-wide bound needs **two** rows,
 * and deleting one would leave half the patient population with no red flag and
 * nothing detecting the asymmetry (#98).
 */
export function isSafetyRangeType(rangeType: string): boolean {
  return (SAFETY_RANGE_TYPES as readonly string[]).includes(rangeType);
}
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
