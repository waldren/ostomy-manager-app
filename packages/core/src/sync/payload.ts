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

import type { CanonicalVolume, CanonicalWeight, MeasurementSystem } from '../units/types.js';
import type { EstimationMethodCode } from '../validation/index.js';

import type { EntityId } from './identifiers.js';

/**
 * Entity payloads — `docs/sync-contract.md` §7.
 *
 * The payload is FHIR-**shaped**, not FHIR-valid (§7.1): `code` is a bare
 * LOINC string rather than a `CodeableConcept`, and there is no `subject`
 * reference because §2 forbids any patient identifier on the wire.
 * Assembling a conformant `Bundle` is the export module's job (P5), from
 * the database, not from this wire format.
 */

/**
 * RFC 3339, UTC (`Z`), millisecond precision — matching the schema's
 * `Timestamptz(3)` (§7.3).
 *
 * Deliberately a plain alias and deliberately NOT branded, unlike
 * `ServerSequence`. The hazard §7.3 describes for sequences is silent and
 * unrecoverable (precision quietly lost inside `JSON.parse`); a
 * wrongly-formatted timestamp is neither — it is rejected by server-side
 * validation on the first request that carries it. Branding here would buy
 * a wrapper call at every timestamp in the mobile queue for a failure mode
 * that is already loud.
 */
export type WireInstant = string;

/**
 * `"mL"` or `"kg"` (§7.2). Derived from `../units` rather than restated,
 * so that this stays the ADR-0004 canonical unit set by construction: the
 * client converts before sending and the server never receives ounces.
 */
export type CanonicalWireUnit = CanonicalVolume['unit'] | CanonicalWeight['unit'];

/**
 * FHIR R4 `ObservationStatus`, lowercase on the wire (§7.2), mirroring the
 * `observation_status` enum's `@map` values in
 * `apps/api/prisma/schema.prisma` exactly.
 *
 * The full value set, not the `final`/`entered-in-error` subset v1 write
 * paths need, for the same reason the schema keeps the full set: the
 * column and the wire field are genuinely FHIR's value set, not a guess
 * that a later change would have to widen. Which members the server
 * *accepts* is a separate, narrower question and belongs to `apps/api`.
 *
 * Restated here because `packages/core/src/fhir` (owned by
 * `fhir-data-modeler`, ADR-0007) does not exist yet. When it does, this
 * alias should be replaced by an import from it rather than kept in
 * parallel.
 */
export type ObservationWireStatus =
  | 'registered'
  | 'preliminary'
  | 'final'
  | 'amended'
  | 'corrected'
  | 'cancelled'
  | 'entered-in-error'
  | 'unknown';

/**
 * FHIR `Observation.method` on the wire: the SNOMED CT "Estimation
 * technique" code when estimated, explicitly `null` when measured — never
 * omitted (§7.2), because an absent key cannot be told apart from a client
 * that does not implement the mandatory Measured/Estimated toggle.
 *
 * Written in terms of `packages/core`'s own `EstimationMethodCode` so the
 * two are textually coupled — but be clear about how weak that coupling
 * currently is, because the aspiration is easy to mistake for a control.
 * `EstimationMethodCode`'s resolved arm is `{ resolved: true; code: string }`,
 * so this type collapses to exactly `string | null` today. It does NOT
 * constrain anything, and when D4 resolves to a literal SNOMED code
 * nothing here will change or complain.
 *
 * `method-tracks-d4.type-test.ts` pins that: it asserts the collapse holds
 * and fails the moment D4 narrows the resolved arm, which is the point at
 * which someone must come back and decide whether the wire type should
 * narrow with it. A tripwire, not an enforcement — stated that way because
 * an overstated structural claim in this package is worse than an honest
 * `string | null`.
 *
 * `ESTIMATION_METHOD_CODE` is still `{ resolved: false }`, so no write path
 * can produce a non-null value today. The wire type stays nullable because
 * §7.2 requires the server to be able to *receive* a non-null value from
 * an old or lying client and reject it with `PAYLOAD_FIELD_INVALID`.
 */
export type ObservationMethodWireValue =
  Extract<EstimationMethodCode, { resolved: true }>['code'] | null;

/** FHIR `Observation.valueQuantity`. A JSON number, not a string (§7.3) — its `DECIMAL(12,4)` range is nowhere near the double's exact-integer limit. */
export interface ObservationValueQuantity {
  /** Canonical units always — mL for volume, kg for weight (ADR-0004). A decimal, not an integer (ADR-0005). */
  readonly value: number;
  readonly unit: CanonicalWireUnit;
}

/**
 * The half of an `Observation` payload FHIR defines. §7.1 requires the two
 * halves be separate types intersected into the payload type: the wire
 * stays flat — app-native fields travel as plain siblings, never wrapped
 * in a namespace object and never encoded as FHIR `extension` entries —
 * while the type carries the distinction. `ObservationAppNativeFields` is
 * the set the export module MUST NOT copy into a FHIR `Bundle` (§7.1), and
 * this split is what lets P5 name that set instead of remembering it.
 */
export interface ObservationFhirFields {
  readonly resourceType: 'Observation';
  /** Equals the operation's `entityId`; a mismatch between the two is a protocol error (§7.2). */
  readonly id: EntityId;
  readonly status: ObservationWireStatus;
  /**
   * Bare LOINC code. Which codes a release accepts is a value set read
   * from the database, never a constant here — an unaccepted code is
   * `UNSUPPORTED_CODE` (§6.2).
   */
  readonly code: string;
  readonly valueQuantity: ObservationValueQuantity;
  /** The clinical moment the observation describes — NOT the client timestamp that orders a batch (§1). */
  readonly effectiveDateTime: WireInstant;
  readonly method: ObservationMethodWireValue;
}

/** The half FHIR has no element for (§7.1). One field today. */
export interface ObservationAppNativeFields {
  /**
   * Which system the patient **entered** in, resolved from their profile
   * at entry time on the device and never re-derived server-side from the
   * current profile (ADR-0012): the profile is mutable, so deriving it
   * later is wrong precisely for the patients who switched. Permanent and
   * unrecoverable per row if stored wrongly.
   */
  readonly enteredMeasurementSystem: MeasurementSystem;

  /**
   * The IANA zone the device reported at entry (ADR-0016), never a UTC
   * offset — an offset cannot express DST, so the patient's day would be
   * computed wrongly for half the year.
   *
   * This is what every "daily" figure in the SRS groups by. The derived
   * `localDate` is deliberately NOT on the wire: it is a pure function of
   * this and `effectiveDateTime`, so a client-supplied one would be a
   * second source of truth whose disagreement nothing would detect
   * (`docs/sync-contract.md` §7.2).
   *
   * Client-asserted on the same footing as `enteredMeasurementSystem`
   * (ADR-0012): only the device knows what the patient's clock said, and
   * re-deriving it server-side is wrong precisely for a travelling patient.
   * Permanent and unrecoverable per row — the instant alone does not say
   * where the patient was.
   */
  readonly enteredTimezone: string;
  /**
   * Which kind of fluid this was, as a `fluid_type` value-set member code
   * (SRS AC 2.3 AC1), added at P3.S1.
   *
   * **Optional, and therefore additive under §8** — a new optional payload
   * field on an existing entity is one of the four changes that needs no
   * version bump, and an older client that never sends it keeps working.
   *
   * Meaningful only on an intake entry (LOINC `9000-1`). The categorisation
   * is optional even there, so `null` means "the patient did not say"; on any
   * other code it is meaningless, and sending it is `PAYLOAD_FIELD_INVALID`
   * rather than a harmless extra — a value no read path would ever interpret
   * is worse than an absent one, because it looks like data.
   *
   * A code, never a display label: patient-facing text comes from the i18n
   * catalog (ADR-0006), and a label here would be a second localization
   * pipeline and would freeze a label into stored history.
   */
  readonly fluidTypeCode?: string | null;
}

export type ObservationSyncPayload = ObservationFhirFields & ObservationAppNativeFields;

/**
 * The entity types this contract exchanges, mapped to their payloads.
 *
 * One map rather than a bare union so that `entityType` and `payload` stay
 * correlated in every operation and change entry: a `create` declaring
 * `entityType: 'Observation'` cannot carry some other entity's payload,
 * because the operation types below distribute over this map's keys.
 * Adding `Profile` and `EffectiveRange` at P4 is one line here and is
 * additive under §8.
 */
/** AC 2.4 AC2's relative size modifier, lowercase on the wire like every other coded value here. */
export const MEAL_SIZE = ['small', 'medium', 'large'] as const;
export type MealSize = (typeof MEAL_SIZE)[number];

/**
 * A logged meal (SRS §3.1, AC 2.4) — the first **app-native** entity on this
 * wire, and deliberately not FHIR-shaped.
 *
 * §7.1 draws the line this sits on: payloads use FHIR R4 names "for everything
 * FHIR defines", and app-native fields "travel as plain siblings ... not
 * wrapped in a namespace object and not encoded as FHIR `extension` entries".
 * A meal is app-native *entirely* — FHIR's `NutritionIntake` models a
 * prescribed or administered nutritional product with quantities and
 * nutrients, not "what someone ate, described in their own words, with a
 * relative size". Mapping onto it would assert a conformance this entity does
 * not have, and §7.1's closing rule already forbids the export module from
 * copying an app-native sibling into a Bundle.
 *
 * So there is no `resourceType` here. That key is FHIR's, and putting it on a
 * non-FHIR entity would be the assertion this type exists to avoid.
 *
 * Every other field matches `ObservationSyncPayload`'s conventions exactly,
 * because they are contract-wide rather than FHIR-derived: `id` equals the
 * operation's `entityId` (§7.2), `effectiveDateTime` is RFC 3339 with exactly
 * three fractional digits (§7.3), and `enteredTimezone` is an IANA name that
 * defines the patient's day (ADR-0016). `localDate` is absent for the same
 * reason it is absent from an observation — it is a pure function of two
 * fields already here, and a client-supplied one is a second source of truth
 * whose disagreement nothing detects.
 */
export interface MealSyncPayload {
  readonly id: EntityId;
  /**
   * AC 2.4 AC1's free text. Optional — a patient who only tapped quick-tags
   * has still logged a meal — and `null` rather than absent when not given,
   * for `method`'s reason (§7.2): an absent key cannot be told apart from a
   * client that does not implement the field.
   */
  readonly description: string | null;
  /** AC 2.4 AC2. Mandatory: never defaulted, because a default is indistinguishable afterwards from a deliberate answer. */
  readonly size: MealSize;
  /**
   * AC 2.4 AC1's optional quick-tags, as `meal_tag` value-set member codes.
   * Always present, empty when none were chosen — an absent array and an empty
   * one would otherwise mean the same thing to a reader and different things to
   * a writer.
   *
   * Codes, never display text: what a patient reads comes from the i18n
   * catalog (ADR-0006), and a label on this wire would be a second
   * localization pipeline.
   */
  readonly tagCodes: readonly string[];
  /** The clinical moment — when the meal was eaten, not when it was logged (§1). */
  readonly effectiveDateTime: WireInstant;
  /** IANA zone name at entry, never a UTC offset (ADR-0016). */
  readonly enteredTimezone: string;
}

export interface SyncPayloadByEntityType {
  readonly Observation: ObservationSyncPayload;
  readonly Meal: MealSyncPayload;
}

export type SyncEntityType = keyof SyncPayloadByEntityType;

/**
 * The wire spelling of each entity type — FHIR's `resourceType`
 * capitalisation (`"Observation"`), not the `OBSERVATION` spelling of
 * Prisma's `sync_entity_type` enum. Translating between the two is
 * `apps/api`'s job.
 */
export const SYNC_ENTITY_TYPE = {
  OBSERVATION: 'Observation',
  /**
   * P3.S1. A new entity type is **additive** under §8 and needs no version
   * bump — but §8's tolerance runs one way: a client must ignore an unknown
   * field in a RESPONSE, and nothing says it must cope with an unknown
   * `entityType`. An old app receiving a `Meal` in a delta page has no
   * handler for it, so the server owes it the filtering, not the reverse.
   */
  MEAL: 'Meal',
} as const;
