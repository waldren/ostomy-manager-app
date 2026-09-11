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

import { HttpException, HttpStatus } from '@nestjs/common';
import {
  SYNC_PROTOCOL_ERROR_CODE,
  type SyncProtocolErrorCode,
  type SyncProtocolErrorResponse,
} from '@ostomy/core/sync';

/**
 * A protocol error: a client bug that fails the **whole request**, with
 * nothing a patient could correct (`docs/sync-contract.md` §6.1).
 *
 * The distinction from a data error is the one this whole module is
 * organised around. A data error fails **one operation** with a `rejected`
 * result inside a `200`; conflating the two is how "a batch never fails as a
 * unit" turns into "a malformed batch silently half-applies", and how a
 * client bug reaches a patient as a confusing correction prompt.
 *
 * ## The body carries a code and nothing else
 *
 * `{ "error": { "code": "BATCH_OUT_OF_ORDER" } }`. No prose, no field path,
 * no echoed request content, and **no index into the offending operation**.
 *
 * §6.1 is emphatic about this and the reason is worth repeating at the throw
 * site rather than only at the filter: a protocol error is exactly where an
 * implementation reaches for helpful diagnostics, and the request it would
 * quote is a batch of clinical values. An index is not obviously
 * client-supplied content, which is precisely why it is called out — it
 * points *at* one, and a client that logs "operation 7 of 12 was malformed"
 * alongside its own queue has reconstructed the association.
 *
 * `status` is carried on the exception rather than derived from the code, so
 * the two cannot drift: §6.1's table pairs each code with one status
 * (`413` for `BATCH_TOO_LARGE`, `409` for `CURSOR_TOO_OLD`, `400` for the
 * rest), and the constructors below are the only place that pairing is
 * written down.
 */
export class SyncProtocolException extends HttpException {
  readonly code: SyncProtocolErrorCode;

  constructor(code: SyncProtocolErrorCode, status: HttpStatus) {
    // The object body IS the wire response. Typed as
    // `SyncProtocolErrorResponse` so a field added here has to exist on the
    // contract type first — the type is what closes this shape, and Nest
    // serialises an object body verbatim with no framework keys added.
    const body: SyncProtocolErrorResponse = { error: { code } };
    super(body, status);
    this.code = code;
    // Assigned, NOT a `get message()` override. A getter-only accessor on the
    // prototype shadows the own property `Error`'s constructor assigns, and
    // that assignment then throws `TypeError: Cannot set property message of
    // Error which has only a getter` in strict mode — turning every protocol
    // error into a 500. The integration suite caught it on the first test
    // that threw one.
    //
    // Worth having at all because `HttpException` derives `message` from the
    // body only when the body is a string; this body is an object, so a log
    // line would otherwise read "Http Exception" — true and useless. Nothing
    // here is derived from the request.
    this.message = `Sync protocol error (${code})`;
  }
}

/** Malformed JSON, a missing/unknown field at request or operation level, or a duplicate `operationId` (§6.1). */
export function malformedRequest(): SyncProtocolException {
  return new SyncProtocolException(
    SYNC_PROTOCOL_ERROR_CODE.MALFORMED_REQUEST,
    HttpStatus.BAD_REQUEST,
  );
}

/** The `clientTimestamp` array is not non-descending (§3.2). */
export function batchOutOfOrder(): SyncProtocolException {
  return new SyncProtocolException(
    SYNC_PROTOCOL_ERROR_CODE.BATCH_OUT_OF_ORDER,
    HttpStatus.BAD_REQUEST,
  );
}

/** `payload` present on a delete, or absent on a create/update (§3.1). */
export function payloadPresenceInvalid(): SyncProtocolException {
  return new SyncProtocolException(
    SYNC_PROTOCOL_ERROR_CODE.PAYLOAD_PRESENCE_INVALID,
    HttpStatus.BAD_REQUEST,
  );
}

/** `payload.id` does not equal the operation's `entityId` (§7.2). */
export function entityIdMismatch(): SyncProtocolException {
  return new SyncProtocolException(
    SYNC_PROTOCOL_ERROR_CODE.ENTITY_ID_MISMATCH,
    HttpStatus.BAD_REQUEST,
  );
}

/**
 * Missing, expired, or invalid token (§6.1).
 *
 * Not thrown by this module — `JwtAuthGuard` throws its own finer-grained
 * `AUTH_*` codes, and `SyncExceptionFilter` maps any `401` leaving this
 * surface onto this one. Exported so that mapping has a single named source
 * rather than a bare string, and so the code is not one "nothing emits."
 */
export function unauthenticated(): SyncProtocolException {
  return new SyncProtocolException(
    SYNC_PROTOCOL_ERROR_CODE.UNAUTHENTICATED,
    HttpStatus.UNAUTHORIZED,
  );
}

/** More than `SYNC_PUSH_MAX_OPERATIONS` operations (§3.3). */
export function batchTooLarge(): SyncProtocolException {
  return new SyncProtocolException(
    SYNC_PROTOCOL_ERROR_CODE.BATCH_TOO_LARGE,
    HttpStatus.PAYLOAD_TOO_LARGE,
  );
}

/**
 * `since` older than the tombstone purge horizon (§5.4).
 *
 * Unreachable today and deliberately built anyway: the horizon's value waits
 * on the PHI retention period, which is still with counsel (§10). The
 * protocol affordance could not wait, because adding a new protocol error
 * after clients ship is the coordinated-release change §8 describes — free
 * now, expensive for the rest of v1.
 */
export function cursorTooOld(): SyncProtocolException {
  return new SyncProtocolException(SYNC_PROTOCOL_ERROR_CODE.CURSOR_TOO_OLD, HttpStatus.CONFLICT);
}
