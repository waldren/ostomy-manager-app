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
 * §6.1 protocol errors — the whole request fails.
 *
 * The governing distinction this file exists to keep sharp: a protocol
 * error is a **client bug**, fails the request with a `4xx`, and has
 * nothing a patient could correct; a data error (`./reasonCodes.js`)
 * fails one operation inside an otherwise-`200` response and is surfaced
 * for correction. Conflating them is how "a batch never fails as a unit"
 * turns into "a malformed batch silently half-applies", and how a client
 * bug reaches a patient as a confusing correction prompt.
 *
 * These codes and `SyncReasonCode` are deliberately separate types with no
 * overlap, so neither can be returned where the other belongs.
 */

export const SYNC_PROTOCOL_ERROR_CODE = {
  /** Malformed JSON, a missing required top-level field, or an unknown `entityType`/`operationType`. */
  MALFORMED_REQUEST: 'MALFORMED_REQUEST',
  /** The `clientTimestamp` array is not non-descending (§3.2). The server does not reorder, so it cannot repair this. */
  BATCH_OUT_OF_ORDER: 'BATCH_OUT_OF_ORDER',
  /** A `payload` present on a delete, or absent on a create/update (§3.1). */
  PAYLOAD_PRESENCE_INVALID: 'PAYLOAD_PRESENCE_INVALID',
  /** `payload.id` does not equal the operation's `entityId` (§7.2). */
  ENTITY_ID_MISMATCH: 'ENTITY_ID_MISMATCH',
  /** Missing, expired or invalid token. */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /**
   * The token is valid and its subject has **no `patients` row** (§6.1).
   *
   * Not an authentication failure, and the distinction is the whole reason
   * this code exists rather than reusing `UNAUTHENTICATED`. The caller is
   * authenticated; onboarding has not created their record yet. A client told
   * `UNAUTHENTICATED` re-authenticates, succeeds, syncs, is told the same
   * thing, and loops — while the patient's entries queue locally and every
   * screen truthfully reports them saved.
   *
   * `/api/v1/observations` has returned `PATIENT_NOT_PROVISIONED` for this
   * condition since P2.S1a; the sync surface collapsed every 403 into
   * `UNAUTHENTICATED` and so answered differently to the same question
   * (#80). One condition, one code, both surfaces.
   *
   * Nothing retries on this and nothing is quarantined: the queue is fine
   * and the server is fine. It resolves when the patient's record exists.
   */
  PATIENT_NOT_PROVISIONED: 'PATIENT_NOT_PROVISIONED',
  /**
   * A `since` older than the tombstone purge horizon (§5.4). The client
   * wipes local entity state and re-syncs from `since=0`.
   *
   * The horizon's value is blocked on the PHI retention period and is
   * deliberately not named anywhere in this package. The CODE cannot wait
   * for it: adding a protocol error after clients ship is the versioned,
   * coordinated-release change §8 describes, and without this one a purge
   * silently strands deleted clinical rows on any device whose cursor
   * predates it — §5.3's invariant broken through the retention door.
   */
  CURSOR_TOO_OLD: 'CURSOR_TOO_OLD',
  /** More than `SYNC_PUSH_MAX_OPERATIONS` operations. The bound itself is server configuration and is deliberately not named in this package. */
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
} as const;

export type SyncProtocolErrorCode =
  (typeof SYNC_PROTOCOL_ERROR_CODE)[keyof typeof SYNC_PROTOCOL_ERROR_CODE];

/**
 * The entire body. **One property, no room for anything else** — §6.1: no
 * prose, no field path, no echoed request content, no index into the
 * offending operation.
 *
 * That closure is the point rather than minimalism for its own sake. A
 * protocol error is exactly where an implementation reaches for helpful
 * diagnostics, and the request it would quote is a batch of clinical
 * values; the client persists and logs whatever comes back. There is
 * nowhere here to put any of it.
 *
 * A `message` field is the one a future author will want to add. It is
 * the field that turns this into a PHI path, because the first genuinely
 * useful message anyone writes quotes the payload.
 */
export interface SyncProtocolError {
  readonly code: SyncProtocolErrorCode;
}

export interface SyncProtocolErrorResponse {
  readonly error: SyncProtocolError;
}

const KNOWN_PROTOCOL_ERROR_CODES: ReadonlySet<string> = new Set<string>(
  Object.values(SYNC_PROTOCOL_ERROR_CODE),
);

/**
 * Decode-boundary guard, for the same §8 reason as `isSyncReasonCode`:
 * new codes are additive, and an old client must degrade to a generic
 * report rather than crash or render a raw identifier.
 */
export function isSyncProtocolErrorCode(value: unknown): value is SyncProtocolErrorCode {
  return typeof value === 'string' && KNOWN_PROTOCOL_ERROR_CODES.has(value);
}
