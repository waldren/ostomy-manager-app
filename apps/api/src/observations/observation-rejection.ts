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
 * Every way this endpoint can say no, and the one shape it says it in.
 *
 * Three rules govern this file, all of them from `docs/sync-contract.md`
 * §6.2/§6.3, and all of them apply to the direct endpoints exactly as they
 * apply to sync:
 *
 * 1. **A rejection never carries the offending value**, in any field, in any
 *    encoding. `ObservationRejectionDetail` has no field a value could
 *    occupy, which is the same structural argument `packages/core`'s
 *    `ValidationError` makes.
 *
 * 2. **The vocabulary is shared with sync.** `reasonCode` is a
 *    `SyncReasonCode` and `field` is a `SyncFieldPath` (or one of this
 *    endpoint's own query-parameter names, which are server-chosen
 *    constants, never client content). The direct endpoint and the sync
 *    endpoint must not invent two ways to say "this value is not positive".
 *
 * 3. **Bodies are built by naming fields, never by spreading.** TypeScript's
 *    excess-property check does not apply to spread properties, so
 *    `{ ...validationResult, ... }` typechecks cleanly and serialises
 *    whatever the source object carried. Every constructor here projects a
 *    fixed field set and cannot be widened from a call site.
 *
 * What deliberately differs from sync: a *direct* rejection may carry
 * several details at once. A push result names one field because the client
 * is a queue processor walking a patient through corrections one at a time;
 * a direct write is a form submission, where returning every blocking rule
 * at once is the difference between one correction round trip and four.
 * Both use the same codes and the same field paths.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import { SYNC_REASON_CODE, type SyncFieldPath, type SyncReasonCode } from '@ostomy/core/sync';

/**
 * Query-parameter names on `GET /observations`. Not sync field paths — sync
 * has no query surface — but the same closed-set discipline: a `field` value
 * is always one of a fixed list of names this server chose, never a string
 * derived from what a client sent.
 */
export const OBSERVATION_QUERY_FIELD = {
  EFFECTIVE_DATE_TIME_FROM: 'effectiveDateTimeFrom',
  EFFECTIVE_DATE_TIME_TO: 'effectiveDateTimeTo',
  LIMIT: 'limit',
} as const;

export type ObservationQueryField =
  (typeof OBSERVATION_QUERY_FIELD)[keyof typeof OBSERVATION_QUERY_FIELD];

export type ObservationRejectionField = SyncFieldPath | ObservationQueryField;

export interface ObservationRejectionDetail {
  readonly field: ObservationRejectionField;
  readonly reasonCode: SyncReasonCode;
}

/**
 * The top-level code. Coarse on purpose: it tells a client which *class* of
 * problem occurred so it can pick a rendering strategy, while `errors`
 * carries the machine-readable specifics. Copy is never sent — the client
 * renders it from `packages/core`'s i18n catalog (ADR-0006, §6.4).
 */
export const OBSERVATION_ERROR_CODE = {
  /** Transport-level: the payload is not a well-formed Observation. HTTP 400. */
  PAYLOAD_MALFORMED: 'OBSERVATION_PAYLOAD_MALFORMED',
  /** Well-formed, but a Tier 1 rule blocks it. HTTP 422. */
  VALIDATION_BLOCKED: 'OBSERVATION_VALIDATION_BLOCKED',
  /** The client-chosen entity id is not available. HTTP 409. */
  ID_CONFLICT: 'OBSERVATION_ID_CONFLICT',
  /** No such observation for this patient. HTTP 404. */
  NOT_FOUND: 'OBSERVATION_NOT_FOUND',
  /** Query parameters are malformed. HTTP 400. */
  QUERY_INVALID: 'OBSERVATION_QUERY_INVALID',
  /** Authenticated, but no patient record exists for this token subject. HTTP 403. */
  PATIENT_NOT_PROVISIONED: 'PATIENT_NOT_PROVISIONED',
  /**
   * The server failed, and the client is told nothing beyond that. HTTP 500.
   *
   * Added at P2.S1a alongside `ObservationExceptionFilter`, which is what
   * makes a 500 from these routes carry this shape rather than Nest's
   * default body. Deliberately detail-free: a 500 means something escaped
   * its wrapper, and whatever that was is exactly what must not be echoed.
   */
  INTERNAL: 'OBSERVATION_INTERNAL_ERROR',
} as const;

export type ObservationErrorCode =
  (typeof OBSERVATION_ERROR_CODE)[keyof typeof OBSERVATION_ERROR_CODE];

export interface ObservationErrorBody {
  readonly error: {
    readonly code: ObservationErrorCode;
    readonly errors: readonly ObservationRejectionDetail[];
  };
}

function buildErrorBody(
  code: ObservationErrorCode,
  details: readonly ObservationRejectionDetail[],
): ObservationErrorBody {
  return {
    error: {
      code,
      // Rebuilt element by element rather than passed through: whatever
      // produced these details (a zod issue, a `packages/core`
      // `ValidationError`, a caught database error) may carry more than
      // `field` and `reasonCode`, and a spread would ship it.
      errors: details.map((detail) => ({ field: detail.field, reasonCode: detail.reasonCode })),
    },
  };
}

/**
 * The one exception type these endpoints throw for a client-correctable
 * refusal. Extending `HttpException` with an object body makes Nest serialise
 * exactly that object — no framework-supplied `message`, `statusCode` or
 * `error` key, none of which pass through the type that makes this shape
 * safe.
 *
 * The `Error.message` (what a log line would carry) names only the code and
 * the fields, never a value.
 */
export class ObservationRejectedException extends HttpException {
  readonly code: ObservationErrorCode;
  readonly details: readonly ObservationRejectionDetail[];

  constructor(
    code: ObservationErrorCode,
    status: HttpStatus,
    details: readonly ObservationRejectionDetail[],
  ) {
    super(buildErrorBody(code, details), status);
    this.code = code;
    this.details = details.map((detail) => ({
      field: detail.field,
      reasonCode: detail.reasonCode,
    }));
  }

  /**
   * A value-free one-liner safe to log.
   *
   * Deliberately a method rather than an override of `message`:
   * `HttpException`'s constructor *assigns* `this.message`, so a getter-only
   * accessor on this prototype would make that assignment throw at
   * construction time under strict mode. The inherited `message` is derived
   * from the response object, which by construction holds only codes and
   * field names — there is no value in it to leak either way.
   */
  describe(): string {
    const summary = this.details.map((detail) => `${detail.reasonCode}@${detail.field}`).join(', ');
    return `Observation request refused (${this.code})${summary ? `: ${summary}` : ''}`;
  }
}

export function payloadMalformed(detail: ObservationRejectionDetail): ObservationRejectedException {
  return new ObservationRejectedException(
    OBSERVATION_ERROR_CODE.PAYLOAD_MALFORMED,
    HttpStatus.BAD_REQUEST,
    [detail],
  );
}

export function validationBlocked(
  details: readonly ObservationRejectionDetail[],
): ObservationRejectedException {
  // 422, not 400. A Tier 1 block means the client sent a structurally
  // well-formed Observation whose content a clinical rule refuses — the
  // patient can fix it. A 400 means the client is broken and the patient
  // cannot. Clients need to tell those apart without parsing codes: one
  // becomes a field-level correction prompt, the other a generic "this could
  // not be saved" (§6.4).
  return new ObservationRejectedException(
    OBSERVATION_ERROR_CODE.VALIDATION_BLOCKED,
    HttpStatus.UNPROCESSABLE_ENTITY,
    details,
  );
}

/**
 * The client-chosen entity id is already taken.
 *
 * **One code for both cases, deliberately.** The id may belong to this
 * patient (an honest duplicate — a retried create) or to another patient
 * (§2's "an entity id that resolves only to another patient's row is treated
 * as not existing"). Returning different codes would make this endpoint an
 * oracle: a caller holding another patient's observation id could confirm it
 * exists. Returning the same refusal in both cases is structurally incapable
 * of leaking, and it is also the honest answer to a create — this id is not
 * available.
 */
export function entityIdConflict(): ObservationRejectedException {
  return new ObservationRejectedException(OBSERVATION_ERROR_CODE.ID_CONFLICT, HttpStatus.CONFLICT, [
    { field: 'id', reasonCode: SYNC_REASON_CODE.ENTITY_ID_CONFLICT },
  ]);
}

/**
 * No observation with that id for *this* patient.
 *
 * Identical whether the row does not exist at all or exists and belongs to
 * someone else — the two cases are indistinguishable to the caller because
 * they are indistinguishable in the lookup, which is scoped to
 * `(patient, id)` together and therefore never learns the difference.
 */
export function observationNotFound(): ObservationRejectedException {
  return new ObservationRejectedException(OBSERVATION_ERROR_CODE.NOT_FOUND, HttpStatus.NOT_FOUND, [
    { field: 'id', reasonCode: SYNC_REASON_CODE.ENTITY_NOT_FOUND },
  ]);
}

export function queryInvalid(field: ObservationQueryField): ObservationRejectedException {
  return new ObservationRejectedException(
    OBSERVATION_ERROR_CODE.QUERY_INVALID,
    HttpStatus.BAD_REQUEST,
    [{ field, reasonCode: SYNC_REASON_CODE.PAYLOAD_FIELD_INVALID }],
  );
}

/**
 * A verified token whose subject has no `patients` row.
 *
 * Not a 404 and not a 500: the token is valid, the caller is authenticated,
 * and onboarding (P4) has simply not created their record yet. 403 with a
 * distinct code is what lets a client route the user to onboarding instead
 * of showing a save failure.
 */
export function patientNotProvisioned(): ObservationRejectedException {
  return new ObservationRejectedException(
    OBSERVATION_ERROR_CODE.PATIENT_NOT_PROVISIONED,
    HttpStatus.FORBIDDEN,
    [],
  );
}
