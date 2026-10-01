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
 * The wire contract for the admin validation-threshold surface (P3.S3, ADR-0008).
 *
 * ## What this surface may change, and the much longer list of what it may not
 *
 * A threshold differs from a value-set member in exactly one way that matters: its
 * value is **not** retrospective. A stored observation keeps the numbers it was
 * written with, and a threshold governs what future entries are checked against — so
 * unlike `numericValue` on a member, the value here is genuinely editable. That is the
 * whole point of SRS §3.8: "numeric validation bounds are admin-managed
 * configuration, not constants in code", and of AC 13.2 AC2, which expects a change
 * to govern from the next fetch with no application release.
 *
 * Everything else about a threshold row is immutable here, and each for its own
 * reason:
 *
 * **`tier` — because a warning must never become a block.** CLAUDE.md states it
 * without qualification: *"A warning must never become a block — a real 2,500 mL day
 * is the data point the care team most needs."* An endpoint that could flip
 * `TIER_2_SOFT_WARNING` to `TIER_1_HARD_BLOCK` would let one configuration change
 * suppress the clinical signal the two-tier design exists to preserve, with no code
 * change and no release to notice it. The reverse is no better: demoting a
 * `TIER_1_HARD_BLOCK` would quietly stop rejecting structurally impossible input, so
 * negative volumes and future timestamps would begin to persist. A tier change is a
 * migration with a reviewer, not an API call.
 *
 * **`thresholdKey` — because code finds the row by it.** `THRESHOLD_KEY` in
 * `thresholds.service.ts` is the set of keys the server reads, and the service throws
 * when one is missing rather than inventing a default. Renaming a key is therefore
 * indistinguishable from deleting the threshold.
 *
 * **`unit` — because the key already names it.** `stoma_output_single_entry_warning_ml`
 * is mL and `sync_clock_skew_allowance_seconds` is seconds. Editing the unit alone
 * changes what the value means while leaving every reader's interpretation untouched,
 * which is the mistake `ValidationThreshold.unit`'s own column comment anticipates.
 * Changing both together is a different threshold, i.e. a migration.
 *
 * **`patientAdjustable` — because two unrelated rules already set it, and one endpoint
 * cannot tell which applies.** The first version of this comment said it was `false`
 * only for the heart-rate red flag, "which CLAUDE.md names as the one threshold that is
 * not patient-adjustable". Both halves were wrong, and a reviewer checked what I had
 * not: the heart-rate row is not seeded yet (P7), while
 * `sync_clock_skew_allowance_seconds` IS seeded `false` — because a patient who could
 * widen it could make their own device win every conflict (ADR-0019). CLAUDE.md's claim
 * had been stale since that migration landed, and this comment propagated it.
 *
 * So the conclusion stands on firmer ground than it did: there are already two
 * distinct, non-clinical reasons for `false`, and when the red flag arrives there will
 * be a third that is clinical. A single PUT cannot adjudicate between them, and
 * flipping the flag on either existing row has a different consequence.
 *
 * And there is no create and no delete. The rows are seeded by migration precisely
 * because every environment needs them — `ThresholdsService` throws without them, on
 * the Tier 1/Tier 2 path of every observation write — so a created threshold would be
 * configuration no code reads, and a deleted one would 500 the next clinical write.
 */

/**
 * Admin-tool label only, never patient-facing copy (ADR-0006).
 *
 * A wire policy rather than the column's shape — `description` is `TEXT` and keeps any
 * length. The cap exists because the label is copied into `before_value`/`after_value`
 * on an append-only table with no `DELETE` grant anywhere (ADR-0011): an unbounded
 * admin string there is unbounded forever.
 */
export const THRESHOLD_DESCRIPTION_MAX_LENGTH = 500;

export const updateThresholdSchema = z
  .object({
    /**
     * Bounded against the `DECIMAL(12,4)` column, the same shape as a value-set
     * member's quantity: past `10^8` Postgres raises an overflow that surfaces as an
     * opaque 500, and past four decimal places it silently rounds and commits.
     *
     * **Strictly positive, and the first version of this comment got that wrong in the
     * most consequential way available.** It permitted `0` and cited
     * `sync_clock_skew_allowance_seconds` as the reason — the one key where `0` is the
     * most harmful value reachable through this endpoint.
     *
     * Traced rather than assumed: that row becomes `maxClockSkewMs`, and
     * `packages/core`'s own test asserts that `maxClockSkewMs: 0` turns a timestamp 30
     * seconds in the future from `pass` into **`blocked`** — a Tier 1 hard block with no
     * override. So an admin reading "allowance" as "slack I can tighten" would reject
     * every queued entry from every patient whose phone clock runs a second fast, each
     * one landing in the correction inbox describing a problem the patient cannot fix:
     * their clock is wrong and the entry form has no clock field. ADR-0019 names that
     * as "the expensive direction" and argues for keeping the allowance "generous
     * enough that it fires only on genuinely broken clocks".
     *
     * `0` is excluded as a STRUCTURAL refusal, not a clinical bound — the same category
     * as Tier 1's own positive-value rule, which compares against zero in code without
     * being a hardcoded threshold. A soft warning at `0` likewise warns on every entry
     * a patient ever makes.
     *
     * What this still cannot check is whether a value is *clinically* sensible for its
     * key: a 20 mL stoma-output warning passes every rule here, and a 1-second skew
     * allowance passes this one. Both reviews of PR B converged on the fix — a
     * per-key settable range, held as configuration rather than code so it is not a
     * hardcoded threshold wearing a different costume — and it is tracked rather than
     * invented here, because choosing those numbers is a clinical decision and not a
     * refactor. It becomes blocking before the first `TIER_1_HARD_BLOCK` ceiling or the
     * heart-rate red flag is seeded.
     */
    value: z
      .number()
      .gt(0)
      .refine((candidate) => !exceedsMaxMagnitude(candidate), {
        error: `value must be smaller than ${String(MAX_REPRESENTABLE_VALUE_ML)}`,
      })
      .refine((candidate) => !exceedsMaxPrecision(candidate), {
        error: `value must have at most ${String(MAX_VALUE_DECIMAL_PLACES)} decimal places`,
      })
      .meta({
        description:
          'The new bound. Governs from the next client fetch, with no application release (AC 13.2 AC2). Stored in a DECIMAL(12,4) column and rejected if it does not fit, rather than silently rounded.',
      }),
    /**
     * Required and nullable, which it was not: it was optional, with absent meaning
     * "leave it alone". Three things were wrong with that, and the method name was the
     * least of them.
     *
     * The column is `TEXT NULL` and the read surface publishes `string | null`, so
     * clearing a label by sending `''` minted a SECOND "no label" state that this API
     * could never return to `NULL` — the integration spec proved it by restoring with
     * `original.description ?? ''`, because `null` was unsendable. A console would then
     * render `''` and `null` identically while their audit snapshots differed, and the
     * only way back was a migration.
     *
     * It also meant a caller could not submit the representation it had just read
     * (`.strict()` rejects the read shape's other fields), which is the opposite of
     * what `PUT` promises — and "absent means unchanged" is `PATCH`'s semantics by
     * definition, so the method name misdescribed the operation.
     *
     * Required makes the body the complete state of the mutable pair: `null` clears to
     * `NULL`, one empty representation, nothing partial. The cost is that a caller
     * changing only the label must send the current value, which it already had to do.
     */
    description: z.string().max(THRESHOLD_DESCRIPTION_MAX_LENGTH).nullable().meta({
      description:
        'Admin-tool label, never patient-facing copy (ADR-0006). Null clears it. Required, because the body is the complete new state of the two mutable fields.',
    }),
  })
  .strict();

export type UpdateThresholdRequest = z.infer<typeof updateThresholdSchema>;

/**
 * The tiers, as a value so the snapshot type and the response schema cannot drift.
 *
 * Mirrors the `ValidationTier` enum in the Prisma schema. Restated here rather than
 * imported from the generated client because this is the WIRE shape: a tier the
 * database gains is not automatically a tier this API publishes, and a reviewer should
 * see the published set in the contract rather than infer it from a migration.
 */
export const THRESHOLD_TIERS = [
  'TIER_1_HARD_BLOCK',
  'TIER_2_SOFT_WARNING',
  'SAFETY_THRESHOLD',
  'OPERATIONAL',
] as const;

export type ThresholdTier = (typeof THRESHOLD_TIERS)[number];

export const adminThresholdSchema = z.object({
  thresholdKey: z.string(),
  tier: z.enum(THRESHOLD_TIERS),
  value: z.number(),
  unit: z.string().nullable(),
  patientAdjustable: z.boolean(),
  description: z.string().nullable(),
  /**
   * The range `value` may be set within (#93), returned so a caller can show it
   * BEFORE someone types a number the API will refuse.
   *
   * That ordering is the point. The 400 is the backstop; a console or the
   * maintenance script displaying "settable 60 to 3600" is what prevents the
   * mistake. Immutable through this surface — see `IMMUTABLE_FIELDS`.
   *
   * A pair spanning the full width of the `DECIMAL(12,4)` column means no
   * narrower bound has been decided for that key yet, which is the state
   * `stoma_output_single_entry_warning_ml` is deliberately in: the numbers are a
   * clinical judgement and #93 is open for them.
   */
  minSettableValue: z.number(),
  maxSettableValue: z.number(),
  // `z.iso.datetime()` and not a bare string, so a generated console gets a date-time
  // format rather than having to know. It is also the concurrency token a caller sends
  // back on the next write.
  updatedAt: z.iso.datetime(),
});

export type AdminThreshold = z.infer<typeof adminThresholdSchema>;

export const adminThresholdsResponseSchema = z.object({
  thresholds: z.array(adminThresholdSchema),
});

export type AdminThresholdsResponse = z.infer<typeof adminThresholdsResponseSchema>;

/**
 * What an audit row records for a threshold change.
 *
 * Carries the immutable fields as well as the value, deliberately. They cannot change
 * through this surface, so including them is not about detecting a change — it is so
 * that a reader of the audit row a year later can tell what the number MEANT without
 * joining back to a table that may have been migrated since. A bare
 * `{ value: 2000 } -> { value: 1500 }` does not say mL, does not say soft warning, and
 * does not say which rule it fed.
 */
export interface ThresholdSnapshot {
  readonly thresholdKey: string;
  readonly tier: ThresholdTier;
  readonly value: number;
  readonly unit: string | null;
  readonly patientAdjustable: boolean;
  readonly description: string | null;
  /**
   * Immutable, so `before` and `after` always agree — and recorded in both
   * anyway, deliberately.
   *
   * The audit row is the only surviving record of what a bound used to be, and
   * "was this value legal when it was written?" is not answerable from the
   * value alone: a later migration can narrow the range. Without these, an
   * audit reader looking at today's bounds would conclude a historically legal
   * edit had been illegal.
   */
  readonly minSettableValue: number;
  readonly maxSettableValue: number;
}
