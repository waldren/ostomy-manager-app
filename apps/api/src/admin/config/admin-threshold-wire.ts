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
 * **`patientAdjustable` — because it is a safety property.** It is `false` only for
 * the heart-rate red flag today, which CLAUDE.md names as "the one threshold that is
 * not patient-adjustable". Flipping it true would let a patient widen the bound that
 * exists to tell them to seek care.
 *
 * And there is no create and no delete. The rows are seeded by migration precisely
 * because every environment needs them — `ThresholdsService` throws without them, on
 * the Tier 1/Tier 2 path of every observation write — so a created threshold would be
 * configuration no code reads, and a deleted one would 500 the next clinical write.
 */

/** Admin-tool label only, never patient-facing copy (ADR-0006). */
export const THRESHOLD_DESCRIPTION_MAX_LENGTH = 500;

export const updateThresholdSchema = z
  .object({
    /**
     * Bounded against the `DECIMAL(12,4)` column, the same shape as a value-set
     * member's quantity: past `10^8` Postgres raises an overflow that surfaces as an
     * opaque 500, and past four decimal places it silently rounds and commits.
     *
     * Non-negative rather than strictly positive, because `0` is meaningful for at
     * least one row — `sync_clock_skew_allowance_seconds` of `0` means "allow no
     * skew". A negative bound is meaningful for none of them: a soft warning at `-1`
     * warns on every entry a patient ever makes.
     *
     * What this cannot check is whether a value is *clinically* sensible for its key.
     * A 20 mL stoma-output warning passes every rule here and would warn on
     * essentially every entry, which is the failure mode that teaches patients to
     * dismiss warnings. That judgement belongs to whoever is making the change, and
     * the audit row is what makes it reviewable afterwards.
     */
    value: z
      .number()
      .min(0)
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
     * Optional, and absent means "leave it alone" rather than "clear it".
     *
     * `exactOptionalPropertyTypes` is on, so the service must spread-or-omit rather
     * than assign `undefined` — and that distinction is the reason this is not
     * `.nullable()`: a caller who wants to clear the label sends an empty string,
     * which is visibly different in the audit row from never having mentioned it.
     */
    description: z.string().max(THRESHOLD_DESCRIPTION_MAX_LENGTH).optional().meta({
      description:
        'Admin-tool label, never patient-facing copy (ADR-0006). Omit to leave the existing label unchanged.',
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
  updatedAt: z.string(),
});

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
}
