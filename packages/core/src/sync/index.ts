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
 * The sync wire contract types — `docs/sync-contract.md`, implementing
 * ADR-0001. Owned by `nestjs-api-developer` (ADR-0007); read-only to
 * everyone else.
 *
 * This subpath is the single definition of the protocol that `apps/api`
 * (P2.S1b) and `apps/mobile` (P2.S2b) both compile against. Where these
 * types and `docs/sync-contract.md` disagree, the document is right and
 * these types are wrong — a type can be regenerated and a fielded app
 * cannot.
 *
 * There are no thresholds, bounds or defaults here.
 * `sync_clock_skew_allowance_seconds`, `SYNC_PUSH_MAX_OPERATIONS`, the
 * delta page size and the accepted LOINC value set are all configuration,
 * read from the database or the environment by `apps/api`. This package
 * names shapes, never values — enforced by
 * `no-hardcoded-transport-bounds.spec.ts`.
 */

export type { EntityId, OperationId, ServerSequence } from './identifiers.js';
export {
  isEntityId,
  isOperationId,
  isServerSequence,
  isServerSequenceAfter,
  toEntityId,
  toOperationId,
  toServerSequence,
} from './identifiers.js';

export type {
  CanonicalWireUnit,
  ObservationAppNativeFields,
  ObservationFhirFields,
  ObservationMethodWireValue,
  ObservationSyncPayload,
  ObservationValueQuantity,
  ObservationWireStatus,
  SyncEntityType,
  SyncPayloadByEntityType,
  WireInstant,
} from './payload.js';
export { SYNC_ENTITY_TYPE } from './payload.js';

export type { SyncReasonCode, SyncSpecificReasonCode, Tier1ReasonCode } from './reasonCodes.js';
export {
  hasPatientFacingCopy,
  isSyncReasonCode,
  SYNC_REASON_CODE,
  SYNC_SPECIFIC_REASON_CODE,
} from './reasonCodes.js';

export type { SyncFieldPath } from './fieldPaths.js';
export { isSyncFieldPath, SYNC_FIELD_PATH } from './fieldPaths.js';

export type {
  SyncAcceptedResult,
  SyncCreateOperation,
  SyncDeleteOperation,
  SyncOperationResult,
  SyncOperationType,
  SyncPushOperation,
  SyncPushRequest,
  SyncPushResponse,
  SyncRejectedResult,
  SyncResultStatus,
  SyncSupersededResult,
  SyncUpdateOperation,
} from './push.js';
export {
  isAcceptedResult,
  isAppliedResult,
  isRejectedResult,
  isSupersededResult,
  SYNC_OPERATION_TYPE,
  SYNC_RESULT_STATUS,
} from './push.js';

export type {
  SyncDeltaChange,
  SyncDeltaRequest,
  SyncDeltaResponse,
  SyncDeltaTombstone,
  SyncDeltaUpsert,
} from './delta.js';
export { isSyncDeltaTombstone, isSyncDeltaUpsert } from './delta.js';
