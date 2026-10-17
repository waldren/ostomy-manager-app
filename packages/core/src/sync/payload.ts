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
  /**
   * OPTIONAL since P3.S2, and absent only on voided urine.
   *
   * AC 12.1 AC2 lets a patient who cannot measure save a COLOUR ALONE. That
   * is the entry type the feature exists for — the patients least able to
   * measure are the ones whose hydration signal matters most — so the wire
   * has to be able to say "no volume" rather than encode a zero.
   *
   * **A missing volume is not a zero volume.** A urine row without this
   * field recorded a colour instead; it did not record a void of 0 mL. Any
   * consumer that coerces absence to zero produces a daily total that is
   * wrong and raises nothing, which is why the database carries CHECK
   * constraints for the same invariant rather than trusting read paths.
   *
   * Absent on no other code. `observations_value_or_urine_color` refuses a
   * row that has neither a volume nor a colour, and refuses any non-urine
   * code without a volume at all.
   */
  readonly valueQuantity?: ObservationValueQuantity;
  /** The clinical moment the observation describes — NOT the client timestamp that orders a batch (§1). */
  readonly effectiveDateTime: WireInstant;
  readonly method: ObservationMethodWireValue;
}

/** The half FHIR has no element for (§7.1), or has no agreed coding for. */
export interface ObservationAppNativeFields {
  /**
   * The chosen step of the pale-to-dark urine colour scale, or absent.
   *
   * A code from the app-native `urine_color` value set, seeded by
   * migration. Never display text — the label a patient reads comes from
   * the i18n catalog, so there is one localization pipeline rather than
   * two (the same rule `fluidTypeCode` follows).
   *
   * ## Why this sits in the app-native half, when FHIR *does* have an
   * ## element for it
   *
   * FHIR would express this as `Observation.component[]` with a
   * `valueCodeableConcept`, so on structure alone it belongs in the FHIR
   * half. It is classified app-native for a different reason: **there is no
   * agreed code system URI for it.** A pale-to-dark hydration chart is a
   * patient-facing proxy, not a standard lab scale, and no standard
   * terminology was adopted for it (that decision is recorded with the
   * P3.S2 migration).
   *
   * Putting it in the FHIR half would tell P5's export module it may emit
   * this as a coded component — which it cannot do without inventing a
   * system URI. Inventing a terminology value is the exact mistake D4
   * spent sprints avoiding, and a wrong one is invisible until an EHR
   * integration reads it. When a system URI is decided, this field moves
   * halves and the export module gains it in the same change.
   */
  readonly urineColorCode?: string;

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

/**
 * v1's ostomy types (SRS §3.0). Colostomy and ileostomy only: urostomy was cut
 * in SRS Phase 4 Appendix A, because a urostomy's stoma output IS urine, which
 * makes it a different data model rather than a third enum value.
 */
export const OSTOMY_TYPE = ['colostomy', 'ileostomy'] as const;
export type OstomyType = (typeof OSTOMY_TYPE)[number];

/**
 * The patient's profile (P4.S3, SRS §3.10): the three facts onboarding asks
 * for, and nothing else.
 *
 * **Update-only on this wire.** A profile is CREATED by provisioning
 * (`POST /api/v1/onboarding`), which is not a sync operation because a sync
 * push requires a provisioned patient, so the bootstrap cannot be the thing
 * that needs the bootstrap. A `create` or `delete` for this entity type is
 * refused per operation; deleting a profile is account deletion (ADR-0017),
 * which this wire does not do.
 *
 * App-native, like `MealSyncPayload`, and for the same reason it has no
 * `resourceType`. FHIR's `Patient` would hold none of these three fields, and
 * the export module builds what it needs from the database.
 *
 * A full replacement, never a patch (§4), so every field is required. With a
 * patch an omitted field would mean "unchanged", and a client that forgot one
 * would be indistinguishable from one that meant to leave it alone.
 */
export interface ProfileSyncPayload {
  /** Equals the operation's `entityId`: the profile's own id, as `GET /api/v1/profile` reports it. Never the patient's id, which this wire never carries (§2). */
  readonly id: EntityId;
  /** Drives which clinical default range is SUGGESTED (§3.9). Changing it never alters a range the patient confirmed or a physician set. */
  readonly ostomyType: OstomyType;
  /**
   * `YYYY-MM-DD`: a calendar date, never an instant (the column is `@db.Date`).
   *
   * The lower bound of Tier 1 timestamp validation (§3.8), so moving it moves
   * the boundary for entries made **from then on**. Entries already accepted
   * are not re-validated: Tier 1 applies on write, and re-checking history
   * against a mutable profile is the shape ADR-0016 refuses for `localDate`.
   */
  readonly surgeryDate: string;
  /** Governs every volume and weight display (ADR-0004). Changing it rewrites no stored value: each observation keeps the system it was entered in (ADR-0012). */
  readonly measurementSystem: MeasurementSystem;
}

/**
 * Where a range's value came from (SRS §3.9), lowercase on the wire. Also its
 * precedence, highest first: a physician's value is in force over a patient's,
 * a patient's own over a suggestion they confirmed, and a confirmed suggestion
 * over the clinical default.
 */
export const RANGE_PROVENANCE = [
  'physician_set',
  'patient_set',
  'patient_confirmed_suggestion',
  'clinical_default',
] as const;
export type RangeProvenance = (typeof RANGE_PROVENANCE)[number];

/**
 * A range row's lifecycle. Only `active` is ever a threshold: a `proposed` row
 * is a suggestion awaiting a human (AC 14.1 AC2), and `superseded` and
 * `dismissed` are history.
 */
export const RANGE_STATUS = ['proposed', 'active', 'superseded', 'dismissed'] as const;
export type RangeStatus = (typeof RANGE_STATUS)[number];

/**
 * One of the patient's target ranges (P4.S3, SRS §3.9/§3.10), with where it
 * came from. App-native and so without a `resourceType`, for `Meal`'s reason.
 *
 * The delta pull carries every row of every provenance, a physician's included,
 * because a device must be able to show which value is in force and why. A
 * PUSH may only do what a patient may do (§7.6): create their own active value
 * — set by them, or a suggestion they confirmed — or move a row through the
 * lifecycle. It can never write a physician's value (AC 14.1 AC4) and never
 * any row of a safety range type such as the heart-rate red flag.
 *
 * A value is immutable once written. A new value is a new row, and the row it
 * replaces is kept as `superseded` with this one's `previousRangeId` pointing
 * at it, so "why did this change" has an answer without reading audit rows.
 */
export interface EffectiveRangeSyncPayload {
  readonly id: EntityId;
  /** A `clinical_default_range_limits` key, such as `daily_output_ml`. Which keys exist is data, not a type. */
  readonly rangeType: string;
  /** Canonical units (ADR-0004), a JSON number like `valueQuantity.value`. `null` when the range has no lower bound. */
  readonly lowValue: number | null;
  readonly highValue: number | null;
  /** For a single-target range (a target dry weight, P6) rather than a band. */
  readonly targetValue: number | null;
  /** The range type's canonical unit, which must match its limits row. */
  readonly unit: string;
  readonly provenance: RangeProvenance;
  readonly status: RangeStatus;
  /** The row this one replaced. Server-assigned: `null` on a create, and unchanged on an update. */
  readonly previousRangeId: EntityId | null;
}

/**
 * What a patient decided about one Quick-Add widget (P4.S3 slice 5, SRS
 * §3.10, Epic 15 story 3). `none` is how a decision is undone: a row is never
 * deleted, for the reason a profile is not (§7.7).
 */
export const QUICK_ADD_DECISION = ['pinned', 'hidden', 'none'] as const;
export type QuickAddDecision = (typeof QUICK_ADD_DECISION)[number];

/**
 * The patient's decision about one Quick-Add routine (P4.S3 slice 5, §7.7).
 *
 * ## A decision ABOUT a routine, never a stored template
 *
 * A Quick-Add widget is derived on the device from the patient's own recent
 * entries, grouped by every field they asserted (`apps/mobile/src/quickadd`).
 * This entity stores none of that history and nothing a tap could log: only
 * which routine a decision is about, and the decision. The widget a tap logs
 * is still built from the entries, so it still carries a value the patient
 * actually entered (#139 decision 3).
 *
 * The routine's fields are those grouping fields, so a decision names exactly
 * one widget, and a removed widget stays removed however often the routine
 * recurs.
 *
 * ## The id is derived, not random
 *
 * `quickAddPreferenceId`: a UUIDv5 of the routine within the profile's id. Two
 * devices deciding about the same widget therefore write the SAME row, and
 * last-write-wins (§4) settles it; with random ids they would write two rows
 * that disagree with nothing to say which is in force. The server refuses any
 * other id.
 */
export interface QuickAddPreferenceSyncPayload {
  /** `quickAddPreferenceId(profileId, routineKey)` — equal to the operation's `entityId`. */
  readonly id: EntityId;
  /** One of the three Quick-Add observation codes (LOINC). */
  readonly code: string;
  /** The routine's canonical volume in mL, a JSON number. `null` only for a colour-only urine routine. */
  readonly valueMl: number | null;
  /** The SNOMED Measured/Estimated qualifier the routine carries, or `null` where it has no volume. */
  readonly method: string | null;
  readonly fluidTypeCode: string | null;
  readonly urineColorCode: string | null;
  /** The system the routine's entries were made in — part of what identifies it. */
  readonly enteredMeasurementSystem: MeasurementSystem;
  readonly decision: QuickAddDecision;
}

export interface SyncPayloadByEntityType {
  readonly Observation: ObservationSyncPayload;
  readonly Meal: MealSyncPayload;
  readonly Profile: ProfileSyncPayload;
  readonly EffectiveRange: EffectiveRangeSyncPayload;
  readonly QuickAddPreference: QuickAddPreferenceSyncPayload;
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
  /**
   * P4.S3. Additive under §8 for the same reason `MEAL` was: a client that does
   * not handle it skips the change in a delta page and still advances its
   * cursor (§7.2).
   */
  PROFILE: 'Profile',
  /** P4.S3 slice 3 (§7.6). Additive, like `MEAL` and `PROFILE`. */
  EFFECTIVE_RANGE: 'EffectiveRange',
  /** P4.S3 slice 5 (§7.7). Additive, like the three before it. */
  QUICK_ADD_PREFERENCE: 'QuickAddPreference',
} as const;
