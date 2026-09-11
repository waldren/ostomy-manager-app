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
 * One observation, FHIR R4 field names, identical to the sync wire payload (docs/sync-contract.md §7.2).
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
  /** Bare LOINC code. This release accepts 79560-9 (stoma output) only; anything else is UNSUPPORTED_CODE. */
  readonly code: string;
  readonly valueQuantity: ObservationValueQuantity;
  /** The clinical moment the observation describes. RFC 3339, UTC, exactly three fractional digits. */
  readonly effectiveDateTime: string;
  /** SNOMED CT estimation-technique code when estimated; null when measured. The code itself is unresolved (D4), so this release accepts null only. */
  readonly method: string | null;
  /** Which system the patient entered in (ADR-0012). Must agree with the profile at write time. */
  readonly enteredMeasurementSystem: 'metric' | 'imperial';
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
  /** Canonical unit for this code. Always mL for stoma output (ADR-0004). */
  readonly unit: 'mL';
};

/**
 * A Tier 2 soft warning. Advisory only: it appears on a successful response and never blocks a write (SRS §3.8). Carries no clinical value.
 */
export type ObservationWarning = {
  readonly field: string;
  readonly ruleCode: string;
};
