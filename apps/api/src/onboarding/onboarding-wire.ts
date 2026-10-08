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

// From the observations wire module rather than re-declared here, because it is
// the API's single definition of the pair and a second one is how the two drift.
// The import direction is awkward — onboarding does not otherwise depend on
// observations — and the right home is `packages/core/src/units` beside the
// `MeasurementSystem` type it belongs to. Worth moving when a third consumer
// appears; not worth a `packages/core` change for the second.
import { MEASUREMENT_SYSTEMS } from '../observations/observation-wire';

/**
 * The wire shape of onboarding (P4.S1, SRS §3.0, Epic 7).
 *
 * ## Three fields, and the spec is explicit that it is three
 *
 * §3.0: "Only three fields are mandatory before the patient can log — ostomy
 * type, surgery date, and measurement system. Each drives something that cannot
 * be safely defaulted: expected-range selection, post-op context, and every
 * volume and weight display respectively."
 *
 * The reason that rule exists is in the same bullet, and it is a clinical
 * observation rather than a UX preference: "a newly discharged patient may be
 * setting the app up in a hospital bed; a long mandatory setup flow is where
 * they abandon it." So this schema is `strict()` — a fourth field arriving here
 * is a mistake worth a 400 rather than something to ignore, because the shape of
 * this request is the shape of the question the patient is asked.
 *
 * ## Why this is a REST call and not a sync operation
 *
 * `Profile` is a synced entity (`docs/sync-contract.md` line 414: "synced
 * entities in the schema but have no wire payload until P4"), and its later
 * EDITS go through sync at P4.S3 "like any other write". Provisioning does not,
 * for three reasons:
 *
 * - A sync push requires a provisioned patient, so the bootstrap cannot be the
 *   thing that needs the bootstrap.
 * - It happens exactly once and necessarily online: the patient has just
 *   completed an OIDC sign-in.
 * - Creating the `Patient` and its `Profile` in ONE transaction means there is
 *   never a patient with no profile. That state would otherwise be something
 *   every later query has to defend against, and `PATIENT_NOT_PROVISIONED`
 *   could not tell it apart from "never onboarded".
 *
 * Two write paths for one entity is a shape this repo has been bitten by
 * (CLAUDE.md, "Both write paths persist every field, and a test compares
 * them"). The mitigation is the same: when P4.S3 adds the sync payload, it adds
 * that comparison test FIRST.
 */

/** v1 covers colostomy and ileostomy only — urostomy was cut in SRS Phase 4 Appendix A, because a urostomy's stoma output IS urine and that is a different data model rather than a third enum value. */
export const ONBOARDING_OSTOMY_TYPES = ['colostomy', 'ileostomy'] as const;

export const onboardingRequestSchema = z
  .object({
    ostomyType: z.enum(ONBOARDING_OSTOMY_TYPES).meta({
      description:
        'Drives clinically appropriate default expected-output ranges rather than a one-size-fits-all baseline (SRS 3.0). v1 is colostomy or ileostomy; urostomy is out of scope.',
    }),
    /**
     * A calendar date, not an instant, and the column agrees (`@db.Date`).
     *
     * A surgery happened on a day; storing an instant would invent a time of day
     * nobody recorded and make the Tier 1 bound depend on the patient's timezone
     * at onboarding rather than on the date they were given.
     */
    surgeryDate: z.iso.date().meta({
      description:
        'The ostomy creation date, as YYYY-MM-DD. Becomes the lower timestamp bound for Tier 1 entry validation (SRS 3.0, 3.8).',
    }),
    measurementSystem: z.enum(MEASUREMENT_SYSTEMS).meta({
      description:
        'Governs every volume AND weight (SRS 3.0, revised in Phase 5, ADR-0004). One choice for both dimensions, so incoherent pairings such as mL with pounds are unrepresentable rather than merely unselectable.',
    }),
  })
  .strict();

export type OnboardingRequest = z.infer<typeof onboardingRequestSchema>;

/**
 * What a client reads back, and what `GET /profile` answers with.
 *
 * Carries no patient identifier. The caller is the patient — every route here is
 * behind `JwtAuthGuard` and resolves the subject from the verified token — so an
 * id in the body would be a patient identifier on the wire that nothing needs,
 * which is the shape `GET /api/v1/observations` already refuses for the same
 * reason.
 */
export const profileResponseSchema = z.object({
  ostomyType: z.enum(ONBOARDING_OSTOMY_TYPES),
  surgeryDate: z.iso.date(),
  measurementSystem: z.enum(MEASUREMENT_SYSTEMS),
});

export type ProfileResponse = z.infer<typeof profileResponseSchema>;

/**
 * How far back a surgery date may be, and why there is a bound at all.
 *
 * An unbounded past date is not harmless: this value becomes the Tier 1 lower
 * timestamp bound, so a typo of `1025-03-04` silently disables that rule for the
 * life of the account, and nothing downstream would report it. Fifty years is
 * well beyond any plausible ostomy history while still refusing a slipped
 * century.
 */
export const MAX_SURGERY_DATE_AGE_YEARS = 50;

/**
 * How far ahead of UTC the "not in the future" check must tolerate, and why a
 * bound that looks like slack is actually correctness.
 *
 * The surgery date is a **calendar date** chosen on the patient's own device,
 * and this request carries no timezone — three fields, per SRS §3.0, and adding
 * a fourth to answer this would be the wrong trade. So the server compares a
 * date against an instant, and for every patient whose local date is already
 * ahead of the UTC date, the honest answer "today" looks like tomorrow.
 *
 * Measured, not assumed: at 08:00 in Tokyo, 09:00 in Auckland or 02:00 in
 * Kiritimati, `YYYY-MM-DD` for the patient's own today parses to a UTC midnight
 * later than `now`, so a strict comparison answered 400 `in_the_future`. That is
 * nine hours of every day in Tokyo and fourteen in Kiritimati, and it refused
 * precisely the patient SRS §3.0 describes — someone setting the app up in a
 * hospital bed on the day of their surgery, who has no way to interpret the
 * refusal and no reason to wait nine hours and try again.
 *
 * Fourteen hours is the maximum UTC offset in use anywhere (UTC+14), so this
 * admits every real "today" and nothing beyond one calendar day. The residual
 * cost is accepting a date up to a day ahead for a patient at or behind UTC, and
 * that is the cheaper error by a wide margin: a surgery date one day ahead only
 * blocks entries the patient backdates into that day, while a refusal blocks
 * setup entirely. The client, which DOES know its own zone, checks exactly.
 */
export const MAX_TIMEZONE_HOURS_AHEAD_OF_UTC = 14;
