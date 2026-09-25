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

// GENERATED FILE — DO NOT EDIT.
//
// Regenerate with: pnpm --filter @ostomy/api api-client:generate
// Source: apps/api/openapi.json, emitted from the running module graph.
// Owner: nobody. ADR-0007 makes this path generated and never hand-edited.

/**
 * Absent entirely on a tombstone — not null, not empty (§5.2).
 */
export type Observation = {
  readonly resourceType: 'Observation';
  /** Client-generated UUID. The server does not mint entity ids (ADR-0001). */
  readonly id: string;
  /** FHIR ObservationStatus. This release accepts final only. */
  readonly status:
    | 'registered'
    | 'preliminary'
    | 'final'
    | 'amended'
    | 'corrected'
    | 'cancelled'
    | 'entered-in-error'
    | 'unknown';
  /** Bare LOINC code. This release accepts 79560-9 (stoma output), 9000-1 (oral fluid intake) and 9187-6 (voided urine); anything else is UNSUPPORTED_CODE. */
  readonly code: string;
  readonly valueQuantity?: ObservationValueQuantity;
  /** The clinical moment the observation describes. RFC 3339, UTC, exactly three fractional digits. */
  readonly effectiveDateTime: string;
  /** SNOMED CT estimation-technique code when estimated; null when measured. The code itself is unresolved (D4), so this release accepts null only. */
  readonly method: string | null;
  /** Which system the patient entered in (ADR-0012). Must agree with the profile at write time. */
  readonly enteredMeasurementSystem: 'metric' | 'imperial';
  /** IANA zone name the device reported at entry (ADR-0016), never a UTC offset. Defines the patient's day, which every daily figure groups by. The server validates only that it resolves. */
  readonly enteredTimezone: string;
  /** Which kind of fluid this was, as a `fluid_type` value-set member code (SRS AC 2.3 AC1). Optional on an intake entry and meaningless on any other code — sending it with a non-intake code is PAYLOAD_FIELD_INVALID. A code, never a display label: the patient-facing text comes from the i18n catalog (ADR-0006). */
  readonly fluidTypeCode?: string | null;
  /** The chosen step of the pale-to-dark urine colour scale, as a `urine_color` value-set member code (SRS AC 12.1 AC2). Optional on a voided-urine entry and meaningless on any other code — sending it with a non-urine code is PAYLOAD_FIELD_INVALID. It is the ONLY field a colour-without-volume entry carries, so a urine entry with neither this nor valueQuantity records nothing and is refused. A code, never a display label: the patient-facing text comes from the i18n catalog (ADR-0006). */
  readonly urineColorCode?: string | null;
};

export type ObservationCreateResponse = {
  /** One observation, FHIR R4 field names, identical to the sync wire payload (docs/sync-contract.md §7.2). */
  readonly observation: Observation;
  readonly warnings: ReadonlyArray<ObservationWarning>;
};

export type ObservationErrorResponse = {
  readonly error: {
    readonly code:
      | 'OBSERVATION_PAYLOAD_MALFORMED'
      | 'OBSERVATION_VALIDATION_BLOCKED'
      | 'OBSERVATION_ID_CONFLICT'
      | 'OBSERVATION_NOT_FOUND'
      | 'OBSERVATION_QUERY_INVALID'
      | 'PATIENT_NOT_PROVISIONED'
      | 'OBSERVATION_INTERNAL_ERROR';
    readonly errors: ReadonlyArray<ObservationRejectionDetail>;
  };
};

export type ObservationListResponse = {
  readonly observations: ReadonlyArray<Observation>;
};

/**
 * One reason a request was refused. Names a field and a stable machine-readable code, never the offending value (docs/sync-contract.md §6.3).
 */
export type ObservationRejectionDetail = {
  readonly field: string;
  readonly reasonCode: string;
};

export type ObservationsListQuery = {
  /** Narrow to one observation code. Omit to receive every code this release accepts, which is what makes Daily Net Fluid Balance (intake minus output) computable from a single response. An unaccepted code is refused rather than ignored. */
  readonly code?: string;
  /** Inclusive lower bound on effectiveDateTime. RFC 3339, UTC, three fractional digits. */
  readonly effectiveDateTimeFrom?: string;
  /** Inclusive upper bound on effectiveDateTime. RFC 3339, UTC, three fractional digits. */
  readonly effectiveDateTimeTo?: string;
  /** Page size. Clamped to the server maximum rather than refused. */
  readonly limit?: number;
};

export type ObservationValueQuantity = {
  /** Canonical mL (ADR-0004). A positive decimal, not an integer-only field. */
  readonly value: number;
  /** Canonical unit, determined by `code` (ADR-0004): mL for volumetric entries, kg for weight. A unit that disagrees with the code is PAYLOAD_FIELD_INVALID. */
  readonly unit: 'mL' | 'kg';
};

/**
 * A Tier 2 soft warning. Advisory only: it appears on a successful response and never blocks a write (SRS §3.8). Carries no clinical value.
 */
export type ObservationWarning = {
  readonly field: string;
  readonly ruleCode: string;
};

export type SyncDeltaChange = {
  readonly entityType: 'Observation' | 'Meal';
  readonly entityId: string;
  /** A server sequence. A JSON string, never a number — 64-bit (§7.3). */
  readonly serverSequence: string;
  readonly deleted: boolean;
  /** For a tombstone, the client timestamp of the operation that DELETED the row — not a server receipt time (§5.2). */
  readonly clientUpdatedAt: string;
  /** Absent entirely on a tombstone — not null, not empty (§5.2). */
  readonly payload?: Observation;
};

export type SyncDeltaQuery = {
  /** Page size. A value above the server maximum is CLAMPED, never refused (§5.1) — the client discovers the real page size from the response. */
  readonly limit?: string;
  /** Server sequence, EXCLUSIVE. "0" requests everything — the initial sync of a newly installed app. A string, not a number (§7.3). Absent or non-numeric is MALFORMED_REQUEST. */
  readonly since: string;
};

export type SyncDeltaResponse = {
  /** Ordered by serverSequence ascending. */
  readonly changes: ReadonlyArray<SyncDeltaChange>;
  /** The highest sequence the server is willing to let the client advance to — not necessarily the highest in changes, and never derived by the client from the rows it received (§5.2). */
  readonly cursor: string;
  /** About THIS PAGE, not the server high-water mark. Always false when changes is empty (§5.2). */
  readonly hasMore: boolean;
};

export type SyncOperationResult = {
  readonly operationId: string;
  readonly status: 'accepted' | 'superseded' | 'rejected';
  readonly entityId: string;
  /** Present on accepted and superseded, absent on rejected. A RECEIPT, never a cursor — a client MUST NOT advance its delta cursor from it (§3.6). */
  readonly appliedServerSequence?: string;
  /** Present only on rejected. Never carries the offending value (§6.3). */
  readonly reasonCode?:
    | 'VALUE_NOT_NUMERIC'
    | 'VALUE_NOT_POSITIVE'
    | 'VALUE_EXCEEDS_MAX_MAGNITUDE'
    | 'VALUE_EXCEEDS_MAX_PRECISION'
    | 'METHOD_REQUIRED'
    | 'METHOD_NOT_APPLICABLE'
    | 'EFFECTIVE_DATE_TIME_IN_FUTURE'
    | 'EFFECTIVE_DATE_TIME_BEFORE_SURGERY'
    | 'CLIENT_TIMESTAMP_OUT_OF_RANGE'
    | 'ENTITY_NOT_FOUND'
    | 'ENTITY_ID_CONFLICT'
    | 'UNSUPPORTED_CODE'
    | 'UNSUPPORTED_STATUS'
    | 'PAYLOAD_FIELD_INVALID'
    | 'PAYLOAD_FIELD_UNRECOGNIZED';
  /** Present only on rejected. A closed set (§6.2). */
  readonly field?:
    | 'operationId'
    | 'entityType'
    | 'entityId'
    | 'operationType'
    | 'clientTimestamp'
    | 'payload'
    | 'resourceType'
    | 'id'
    | 'status'
    | 'code'
    | 'valueQuantity.value'
    | 'valueQuantity.unit'
    | 'effectiveDateTime'
    | 'method'
    | 'enteredMeasurementSystem'
    | 'enteredTimezone'
    | 'fluidTypeCode'
    | 'urineColorCode'
    | 'description'
    | 'size'
    | 'tagCodes';
  /** Diagnostic. A client MUST NOT branch clinical behaviour on it (§3.7). */
  readonly replayed: boolean;
};

export type SyncProtocolErrorResponse = {
  readonly error: {
    readonly code:
      | 'MALFORMED_REQUEST'
      | 'BATCH_OUT_OF_ORDER'
      | 'PAYLOAD_PRESENCE_INVALID'
      | 'ENTITY_ID_MISMATCH'
      | 'UNAUTHENTICATED'
      | 'PATIENT_NOT_PROVISIONED'
      | 'CURSOR_TOO_OLD'
      | 'BATCH_TOO_LARGE';
  };
};

export type SyncPushOperation = {
  /** Client-generated at enqueue. Never the entity id (§1). */
  readonly operationId: string;
  readonly entityType: 'Observation' | 'Meal';
  readonly entityId: string;
  readonly operationType: 'create' | 'update' | 'delete';
  /** When the WRITE was made. Orders the batch and decides last-write-wins — distinct from effectiveDateTime, the clinical moment (§1). */
  readonly clientTimestamp: string;
  /** Absent for a delete, required otherwise (§3.1). */
  readonly payload?: Observation;
};

export type SyncPushRequest = {
  /** Applied in array order, and MUST be non-descending in clientTimestamp (§3.2). At most SYNC_PUSH_MAX_OPERATIONS (§3.3). */
  readonly operations: ReadonlyArray<SyncPushOperation>;
};

export type SyncPushResponse = {
  readonly results: ReadonlyArray<SyncOperationResult>;
};
