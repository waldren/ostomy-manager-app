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
 * The wire shape of a patient's target ranges (P4.S2 slice 3, SRS §3.9).
 *
 * ## Read-only, and that is a decision rather than a stage
 *
 * There is no write here, and there will not be one on this surface.
 * `EffectiveRange` is a **synced entity** — `docs/sync-contract.md` line 414:
 * "`Profile` and `EffectiveRange` are synced entities in the schema but have no
 * wire payload until P4; adding them is additive (§8)" — and P4.S3's row in the
 * implementation plan says preference changes "queue through the sync path like
 * any other write". §3.10's own list includes "target ranges and suggestion
 * review".
 *
 * So the confirm/edit/dismiss writes belong to that sprint, through the sync
 * path, once. Adding REST writes here would give one entity two write paths
 * permanently — the shape CLAUDE.md names as having already cost this repo a
 * field-drop that survived two sprints ("both write paths persist every field,
 * and a test compares them"). Onboarding took the REST route for a reason that
 * does not apply here: a sync push needs a provisioned patient, so provisioning
 * could not itself be a sync operation. Confirming a range has no such
 * bootstrap problem.
 *
 * What that costs this sprint is stated on #130 rather than left implicit: AC 1,
 * AC 2 and AC 4 need only this read, and AC 3's confirmation action lands with
 * the rest of §3.10.
 */

/** §3.9's precedence order is the order of this enum, highest first. */
export const RANGE_PROVENANCES = [
  'PHYSICIAN_SET',
  'PATIENT_SET',
  'PATIENT_CONFIRMED_SUGGESTION',
  'CLINICAL_DEFAULT',
] as const;

/**
 * What a surface needs to state a suggestion's basis in its own words (AC 1).
 *
 * Fields, never a prepared sentence. "Typical for an ileostomy about three
 * months after surgery" is patient-facing copy, so it belongs in the i18n
 * catalog (ADR-0006) where a reviewer auditing tone can find it — an English
 * string assembled here would be untranslatable and invisible to that review.
 * §3.9's framing constraint is exactly the kind of thing that review is for:
 * copy must describe what is typical, never prescribe.
 */
export const rangeBasisSchema = z.object({
  ostomyType: z.enum(['colostomy', 'ileostomy']).meta({
    description: 'The ostomy type the suggestion is keyed to (SRS §3.9).',
  }),
  daysPostOp: z.int().meta({
    description: "Days since the patient's surgery date, for the copy that states the basis.",
  }),
  minDaysPostOp: z.int(),
  maxDaysPostOp: z.int().nullable().meta({
    description: 'Null for the open-ended final window — "and beyond".',
  }),
});

export const resolvedRangeSchema = z.object({
  rangeType: z.string().meta({
    description:
      'What the range governs, e.g. daily_output_ml. Shares a key space with the admin clinical default ranges.',
  }),
  unit: z.string(),
  lowValue: z.number().nullable().meta({
    description: 'Null where the range is a ceiling only.',
  }),
  highValue: z.number().nullable().meta({
    description:
      'Null where the range is a floor only — urine adequacy and net fluid balance both are, because passing too little is the concern rather than too much.',
  }),
  provenance: z.enum(RANGE_PROVENANCES).meta({
    description:
      "Where the value in force came from, in §3.9's precedence order. CLINICAL_DEFAULT means no patient row exists and this is a suggestion.",
  }),
  isActiveThreshold: z.boolean().meta({
    description:
      'Whether this may be used as an anomaly threshold (AC 14.1 AC2). False for a clinical default nobody has confirmed: "no value becomes an active threshold without a human confirming it". A client must not flag an anomaly against a range where this is false.',
  }),
  divergesFromPhysician: z.boolean().meta({
    description:
      "Whether the patient holds a value of their own alongside a physician-set one (AC 14.1 AC4). The physician's value is the one in force; this is reported so a surface can say so rather than silently showing a number the patient did not choose.",
  }),
  basis: rangeBasisSchema.nullable().meta({
    description:
      'The clinical default window this suggestion came from, or null when no default covers this patient today.',
  }),
});

export const rangesResponseSchema = z.object({
  ranges: z.array(resolvedRangeSchema),
});

export type ResolvedRangeWire = z.infer<typeof resolvedRangeSchema>;
export type RangesResponse = z.infer<typeof rangesResponseSchema>;
