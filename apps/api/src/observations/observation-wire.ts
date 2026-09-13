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
 * The wire shape of an `Observation` on the direct (non-sync) endpoints, and
 * the JSON Schemas published for it.
 *
 * **This file does not get to invent a shape.** `docs/sync-contract.md` §7.2
 * fixes the payload for `Observation` — FHIR field names (`resourceType`,
 * `status`, `code`, `valueQuantity.value`, `valueQuantity.unit`,
 * `effectiveDateTime`, `method`) plus the one app-native sibling
 * (`enteredMeasurementSystem`) — and P2.S1b's sync endpoint carries exactly
 * the same object. Two shapes for one entity is the failure this file exists
 * to prevent, so the key set here is asserted against `packages/core`'s
 * `ObservationSyncPayload` in `observation-wire.spec.ts` rather than left to
 * review.
 *
 * Two schemas, deliberately:
 *
 *   - `observationResourceSchema` is the **published** shape. It is what the
 *     OpenAPI document (and therefore `packages/core/src/api-client`) says
 *     an Observation is, in both directions — request body and response body
 *     are the same object.
 *
 *   - `observationRequestParseSchema` is the **runtime parser**, and it is
 *     deliberately more permissive in exactly two places: `valueQuantity
 *     .value` is `unknown` and `method` may be absent. That is not laxity;
 *     it is what routes those two failures to `packages/core`'s Tier 1 rules
 *     (`VALUE_NOT_NUMERIC`, `METHOD_REQUIRED`) instead of letting a
 *     transport-layer type check pre-empt them with a different code. AC 2.1
 *     AC 1 and AC 2.2 AC 1 are about those two rules; a payload that fails
 *     them must fail *them*, not fail a zod "expected number" check that
 *     happens to reject it too. `observation-wire.spec.ts` asserts the two
 *     schemas have identical key sets so they cannot drift apart.
 *
 * Nothing here ever puts a submitted value into an error, a message, or a
 * log line — see `observation-rejection.ts`.
 */
import { SYNC_FIELD_PATH, type SyncFieldPath } from '@ostomy/core/sync';
import { z } from 'zod';

/**
 * The LOINC code this sprint accepts, and the only one. Anything else is
 * `UNSUPPORTED_CODE` (`docs/sync-contract.md` §6.2).
 *
 * This is a code constant and not an admin-managed value set, which is worth
 * saying out loud next to CLAUDE.md's "thresholds and value sets are
 * configuration read from the database". The distinction is whether an admin
 * change *alone* can make the new configuration correct. A threshold — the
 * 2,000 mL soft warning — is pure clinical tuning: change the row, the
 * behaviour is right, no deploy. A new observation code is not: fluid
 * intake, voided urine, body weight and heart rate each need their own
 * canonical unit, their own hydration-signal handling and their own
 * validation path, none of which exist until their sprint lands. Making the
 * accepted-code set admin-editable would let an admin switch on an endpoint
 * that then writes rows no read path understands.
 */
export const STOMA_OUTPUT_LOINC_CODE = '79560-9';

/** ADR-0004: volume is canonical mL on the wire and at rest, always. */
export const STOMA_OUTPUT_CANONICAL_UNIT = 'mL';

/**
 * FHIR R4 `ObservationStatus`, all eight members, lowercase on the wire.
 *
 * The published type is the full value set while the *accepted* set is
 * `final` alone (§7.2): widening what a release accepts is additive under
 * §8, whereas widening the published type later is not.
 */
export const OBSERVATION_WIRE_STATUSES = [
  'registered',
  'preliminary',
  'final',
  'amended',
  'corrected',
  'cancelled',
  'entered-in-error',
  'unknown',
] as const;

/** What P2 accepts. Anything else is `UNSUPPORTED_STATUS`. */
export const ACCEPTED_OBSERVATION_STATUS = 'final';

export const MEASUREMENT_SYSTEMS = ['metric', 'imperial'] as const;

const valueQuantitySchema = z
  .strictObject({
    value: z.number().meta({
      description: 'Canonical mL (ADR-0004). A positive decimal, not an integer-only field.',
    }),
    unit: z.literal(STOMA_OUTPUT_CANONICAL_UNIT).meta({
      description: 'Canonical unit for this code. Always mL for stoma output (ADR-0004).',
    }),
  })
  .meta({ title: 'ObservationValueQuantity' });

/**
 * The published `Observation` — request and response alike.
 *
 * Note what is absent, all of it deliberately (§7.2): no `patientId` (the
 * patient comes from the token, and the field that could carry the attack is
 * simply not here), no `serverSequence`, no `deletedAt`, no
 * `createdAt`/`updatedAt`.
 */
export const observationResourceSchema = z
  .strictObject({
    resourceType: z.literal('Observation'),
    id: z.uuid().meta({
      description: 'Client-generated UUID. The server does not mint entity ids (ADR-0001).',
    }),
    status: z.enum(OBSERVATION_WIRE_STATUSES).meta({
      description: 'FHIR ObservationStatus. This release accepts final only.',
    }),
    code: z.string().meta({
      description:
        'Bare LOINC code. This release accepts 79560-9 (stoma output) only; anything else is UNSUPPORTED_CODE.',
    }),
    valueQuantity: valueQuantitySchema,
    effectiveDateTime: z.iso.datetime({ precision: 3 }).meta({
      description:
        'The clinical moment the observation describes. RFC 3339, UTC, exactly three fractional digits.',
    }),
    method: z.string().nullable().meta({
      description:
        'SNOMED CT estimation-technique code when estimated; null when measured. The code itself is unresolved (D4), so this release accepts null only.',
    }),
    enteredMeasurementSystem: z.enum(MEASUREMENT_SYSTEMS).meta({
      description:
        'Which system the patient entered in (ADR-0012). Must agree with the profile at write time.',
    }),
    enteredTimezone: z.string().min(1).max(64).meta({
      description:
        "IANA zone name the device reported at entry (ADR-0016), never a UTC offset. Defines the patient's day, which every daily figure groups by. The server validates only that it resolves.",
    }),
  })
  .meta({
    title: 'Observation',
    description:
      'One observation, FHIR R4 field names, identical to the sync wire payload (docs/sync-contract.md §7.2).',
  });

export type ObservationResource = z.infer<typeof observationResourceSchema>;

/**
 * The runtime parser. See the file header for why `value` and `method` are
 * looser here than in the published schema — and `observation-wire.spec.ts`
 * for the test that stops that looseness spreading to any other field.
 */
export const observationRequestParseSchema = z.strictObject({
  resourceType: z.literal('Observation'),
  id: z.uuid(),
  status: z.enum(OBSERVATION_WIRE_STATUSES),
  code: z.string(),
  valueQuantity: z.strictObject({
    // `unknown`, not `number`: a non-numeric value is Tier 1
    // VALUE_NOT_NUMERIC (packages/core), never a transport type error.
    value: z.unknown().optional(),
    unit: z.string(),
  }),
  effectiveDateTime: z.iso.datetime({ precision: 3 }),
  // Optional at runtime, required in the published schema: an *absent*
  // `method` key is the "no Measured/Estimated selection was made" case,
  // which §7.2 routes to Tier 1 METHOD_REQUIRED (AC 2.2 AC 1), not to a
  // shape error.
  method: z.unknown().optional(),
  enteredMeasurementSystem: z.string(),
  // `z.string()`, not the length-bounded form in the published schema: a
  // zone that is merely unresolvable is a CONTENT problem this release
  // reports as PAYLOAD_FIELD_INVALID naming `enteredTimezone`, not a
  // transport shape error naming `payload`. The distinction matters to the
  // correction inbox, which shows the patient a field.
  enteredTimezone: z.string(),
});

export type ObservationRequestParsed = z.infer<typeof observationRequestParseSchema>;

/** Wire field paths, drawn from the closed set `packages/core/src/sync` owns. */
export const OBSERVATION_FIELD = {
  RESOURCE_TYPE: SYNC_FIELD_PATH.RESOURCE_TYPE,
  ID: SYNC_FIELD_PATH.ID,
  STATUS: SYNC_FIELD_PATH.STATUS,
  CODE: SYNC_FIELD_PATH.CODE,
  VALUE: SYNC_FIELD_PATH.VALUE_QUANTITY_VALUE,
  UNIT: SYNC_FIELD_PATH.VALUE_QUANTITY_UNIT,
  EFFECTIVE_DATE_TIME: SYNC_FIELD_PATH.EFFECTIVE_DATE_TIME,
  METHOD: SYNC_FIELD_PATH.METHOD,
  ENTERED_MEASUREMENT_SYSTEM: SYNC_FIELD_PATH.ENTERED_MEASUREMENT_SYSTEM,
  ENTERED_TIMEZONE: SYNC_FIELD_PATH.ENTERED_TIMEZONE,
  PAYLOAD: SYNC_FIELD_PATH.PAYLOAD,
} as const;

/**
 * Maps a zod issue path onto one wire field path.
 *
 * Only the path is used — never the issue's `message`, which for an
 * `unrecognized_keys` issue reads `Unrecognized key: "x"` and would echo a
 * client-supplied key straight back into a response the client persists
 * (§6.2, §6.3).
 */
export function fieldPathForIssuePath(path: readonly PropertyKey[]): SyncFieldPath {
  const joined = path.map((segment) => String(segment)).join('.');
  switch (joined) {
    case 'resourceType':
      return OBSERVATION_FIELD.RESOURCE_TYPE;
    case 'id':
      return OBSERVATION_FIELD.ID;
    case 'status':
      return OBSERVATION_FIELD.STATUS;
    case 'code':
      return OBSERVATION_FIELD.CODE;
    // A missing `valueQuantity` object names the value, not the wrapper:
    // `valueQuantity` alone is not a member of the closed field-path set,
    // and the value is the field a patient can actually correct.
    case 'valueQuantity':
    case 'valueQuantity.value':
      return OBSERVATION_FIELD.VALUE;
    case 'valueQuantity.unit':
      return OBSERVATION_FIELD.UNIT;
    case 'effectiveDateTime':
      return OBSERVATION_FIELD.EFFECTIVE_DATE_TIME;
    case 'method':
      return OBSERVATION_FIELD.METHOD;
    case 'enteredMeasurementSystem':
      return OBSERVATION_FIELD.ENTERED_MEASUREMENT_SYSTEM;
    case 'enteredTimezone':
      return OBSERVATION_FIELD.ENTERED_TIMEZONE;
    default:
      // An unrecognized key reports `payload` and never the key itself
      // (§6.2). Anything else unmapped lands here too, which is the safe
      // direction: a field path is something we name, never something we
      // echo.
      return OBSERVATION_FIELD.PAYLOAD;
  }
}
