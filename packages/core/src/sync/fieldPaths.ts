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
 * The `field` a rejection may name (§6.2, §6.3).
 *
 * **A closed union, not `string`, and that is the point.** §6.3 says a
 * rejection "never carries the offending value, in any field, in any
 * encoding", and rejection responses are persisted in the client's
 * correction queue and appear in client-side diagnostics. A free-`string`
 * `field` is a field a value fits in — an implementation that writes
 * `field: \`valueQuantity.value (${value})\`` typechecks perfectly and puts
 * PHI in a client log. Enumerating the paths removes the place to put it.
 *
 * Spelled exactly as §3.1 and §7 spell the wire field names, and — following
 * the §3.4 example, which uses `"valueQuantity.value"` — payload paths are
 * **not** prefixed with `payload.`.
 *
 * Growing this set as new entity types land at P4 is additive under §8.
 */
export const SYNC_FIELD_PATH = {
  // Operation-level fields (§3.1). These are not paths into `payload` at
  // all: `CLIENT_TIMESTAMP_OUT_OF_RANGE` names `clientTimestamp`, and
  // `ENTITY_NOT_FOUND` and `ENTITY_ID_CONFLICT` name `entityId`. §6.2
  // covers both groups.
  OPERATION_ID: 'operationId',
  ENTITY_TYPE: 'entityType',
  ENTITY_ID: 'entityId',
  OPERATION_TYPE: 'operationType',
  CLIENT_TIMESTAMP: 'clientTimestamp',
  /**
   * The payload as a whole. This is what `PAYLOAD_FIELD_UNRECOGNIZED`
   * names: the unrecognized key is client-supplied content, and echoing
   * client-supplied content back into a response the client logs is the
   * shape §6.3 forbids. A client that sent the field already knows which
   * one it sent.
   */
  PAYLOAD: 'payload',

  // `Observation` payload fields (§7.2).
  RESOURCE_TYPE: 'resourceType',
  ID: 'id',
  STATUS: 'status',
  CODE: 'code',
  VALUE_QUANTITY_VALUE: 'valueQuantity.value',
  VALUE_QUANTITY_UNIT: 'valueQuantity.unit',
  EFFECTIVE_DATE_TIME: 'effectiveDateTime',
  METHOD: 'method',
  ENTERED_MEASUREMENT_SYSTEM: 'enteredMeasurementSystem',
  /** ADR-0016. Client-asserted IANA zone; the derived `localDate` is server-side and never a wire field. */
  ENTERED_TIMEZONE: 'enteredTimezone',
  /** P3.S1 (SRS AC 2.3 AC1). A `fluid_type` value-set member code — optional on an intake entry, meaningless on any other. */
  FLUID_TYPE_CODE: 'fluidTypeCode',
  /**
   * The colour a volume-less voided-urine entry carries (P3.S2, AC 12.1 AC2).
   *
   * The field a rejection names when that entry is refused: it is the only
   * input the patient can act on, so naming `valueQuantity.value` would point
   * them at a box they deliberately left blank.
   */
  URINE_COLOR_CODE: 'urineColorCode',

  // `Meal` payload fields (§7.4), added at P3.S1. `id` and
  // `effectiveDateTime` above are shared with `Observation` — the paths are
  // per-wire-field, not per-entity, and two entities naming the same field
  // the same way is the point rather than a collision.
  DESCRIPTION: 'description',
  SIZE: 'size',
  TAG_CODES: 'tagCodes',
} as const;

export type SyncFieldPath = (typeof SYNC_FIELD_PATH)[keyof typeof SYNC_FIELD_PATH];

const KNOWN_FIELD_PATHS: ReadonlySet<string> = new Set<string>(Object.values(SYNC_FIELD_PATH));

/**
 * Decode-boundary guard, for the same §8 reason as `isSyncReasonCode`: a
 * new payload field is additive, so a fielded client will eventually
 * receive a `field` it does not know. It shows the generic message.
 */
export function isSyncFieldPath(value: unknown): value is SyncFieldPath {
  return typeof value === 'string' && KNOWN_FIELD_PATHS.has(value);
}
