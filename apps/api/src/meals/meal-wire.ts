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
 * The `Meal` wire shape — `docs/sync-contract.md` §7.4, SRS AC 2.4.
 *
 * Mirrors `observations/observation-wire.ts` in structure, including the
 * published-schema / runtime-parser split: the published schema is what the
 * OpenAPI document and the generated client are built from, while the parser
 * is deliberately looser on the fields whose *content* problems must reach a
 * patient as a named field rather than as a transport shape error.
 *
 * **There is no `resourceType`, and that is the one thing about this file a
 * reader should take away.** A meal is app-native in its entirety. FHIR
 * defines `NutritionIntake` and it models a prescribed or administered
 * nutritional product with quantities and nutrients — not "what someone ate,
 * described in their own words, with a relative size". Carrying the key would
 * assert a conformance this entity does not have, and §7.1 already forbids the
 * export module the mirror-image mistake.
 */
import { SYNC_FIELD_PATH } from '@ostomy/core/sync';
import { z } from 'zod';

/** AC 2.4 AC2's relative scale, lowercase on the wire like every other coded value. */
export const MEAL_SIZES = ['small', 'medium', 'large'] as const;

/**
 * Matches `meals.description`'s `VARCHAR(2000)`. Not a clinical limit — it is
 * an unbounded patient-supplied string reaching a database, and the column
 * has to stop somewhere. A description longer than this is
 * `PAYLOAD_FIELD_INVALID` rather than a silent truncation: truncating a
 * patient's own words without telling them is a data-loss path with no signal
 * on either side.
 */
export const MEAL_DESCRIPTION_MAX_LENGTH = 2000;

/**
 * A bound on how many tags one meal may carry.
 *
 * Not in the SRS, and chosen here rather than left unbounded: `tagCodes` is a
 * client-supplied array that lands in a GIN-indexed column, and an unbounded
 * one is an unbounded write. Twenty is far above what the `meal_tag` value set
 * holds (six today) and far below anything that costs the index — the point is
 * that a number exists, not that this is the right number.
 */
export const MEAL_TAG_CODES_MAX = 20;

/** Matches the value-set member code shape the seed migration writes. */
export const MEAL_TAG_CODE_MAX_LENGTH = 64;

/**
 * The published `Meal` — request and response alike.
 *
 * Absent, all deliberately (§7.4): no `resourceType` (see the file header),
 * no `patientId` (§2 — the field that could carry the attack is simply not
 * here), no `serverSequence`, no `deletedAt`, no `createdAt`/`updatedAt`, and
 * no `localDate` (server-derived, ADR-0016).
 */
export const mealResourceSchema = z
  .strictObject({
    id: z.uuid().meta({
      description: 'Client-generated UUID. The server does not mint entity ids (ADR-0001).',
    }),
    description: z.string().max(MEAL_DESCRIPTION_MAX_LENGTH).nullable().meta({
      description:
        "AC 2.4 AC1's free-text description. Explicitly null when the patient gave none, never omitted — an absent key cannot be told apart from a client that does not implement the field.",
    }),
    size: z.enum(MEAL_SIZES).meta({
      description:
        "AC 2.4 AC2's mandatory relative size modifier. Never defaulted: a default is indistinguishable afterwards from a deliberate answer.",
    }),
    tagCodes: z
      .array(z.string().min(1).max(MEAL_TAG_CODE_MAX_LENGTH))
      .max(MEAL_TAG_CODES_MAX)
      .meta({
        description:
          "AC 2.4 AC1's optional quick-tags, as meal_tag value-set member codes — never display labels (ADR-0006). Always present, [] when none were chosen.",
      }),
    effectiveDateTime: z.iso.datetime({ precision: 3 }).meta({
      description:
        'When the meal was eaten, not when it was logged. RFC 3339, UTC, exactly three fractional digits.',
    }),
    enteredTimezone: z.string().min(1).max(64).meta({
      description:
        "IANA zone name the device reported at entry (ADR-0016), never a UTC offset. Defines the patient's day. The server validates only that it resolves.",
    }),
  })
  .meta({
    title: 'Meal',
    description:
      'One logged meal. App-native, not FHIR — see docs/sync-contract.md §7.4 for why it carries no resourceType.',
  });

export type MealResource = z.infer<typeof mealResourceSchema>;

/**
 * The runtime parser.
 *
 * Looser than the published schema on exactly the fields whose bad values are
 * CONTENT rather than shape, for `observation-wire.ts`'s reason: a content
 * problem must reach the patient's correction inbox naming a field they can
 * see, not as a transport error naming `payload`.
 */
export const mealRequestParseSchema = z.strictObject({
  id: z.uuid(),
  // `unknown`: a description of the wrong type, or one over the column bound,
  // is PAYLOAD_FIELD_INVALID naming `description`.
  description: z.unknown().optional(),
  // `unknown`: an absent `size` is the "no selection made" case AC 2.4 AC2
  // forbids, and it must name `size` rather than fail the shape.
  size: z.unknown().optional(),
  tagCodes: z.unknown().optional(),
  effectiveDateTime: z.iso.datetime({ precision: 3 }),
  enteredTimezone: z.string(),
});

export type MealRequestParsed = z.infer<typeof mealRequestParseSchema>;

/**
 * Wire field paths for this entity, drawn from the closed set
 * `packages/core/src/sync` owns (§6.2/§6.3) — never free strings, because a
 * free-string `field` is a field a clinical value fits in.
 */
export const MEAL_FIELD = {
  ID: SYNC_FIELD_PATH.ID,
  DESCRIPTION: SYNC_FIELD_PATH.DESCRIPTION,
  SIZE: SYNC_FIELD_PATH.SIZE,
  TAG_CODES: SYNC_FIELD_PATH.TAG_CODES,
  EFFECTIVE_DATE_TIME: SYNC_FIELD_PATH.EFFECTIVE_DATE_TIME,
  ENTERED_TIMEZONE: SYNC_FIELD_PATH.ENTERED_TIMEZONE,
  PAYLOAD: SYNC_FIELD_PATH.PAYLOAD,
} as const;
