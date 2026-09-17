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
export interface SyncPayloadByEntityType {
  readonly Observation: ObservationSyncPayload;
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
} as const;
