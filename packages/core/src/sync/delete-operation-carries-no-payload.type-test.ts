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

import type { EntityId, OperationId } from './identifiers.js';
import type { ObservationSyncPayload, WireInstant } from './payload.js';
import type { SyncDeleteOperation, SyncPushOperation } from './push.js';

/**
 * Type-level proof of §3.1's rule that `payload` is absent for
 * `operationType: "delete"` and required otherwise — the condition §6.1
 * makes a whole-request protocol error.
 *
 * Not one of the three invariants P2.S0 was required to prove, but it
 * falls out of the same discriminated-union shape and is worth pinning:
 * TypeScript's excess-property check narrows a union by its discriminant
 * before checking, so the guarantee holds even when the literal is written
 * against `SyncPushOperation` rather than the delete arm directly. That
 * behaviour is a compiler detail this file makes a build-checked
 * assumption rather than a remembered one.
 *
 * It also has a modest PHI dimension in the same family as §5.2's
 * tombstone rule: a delete that carries the clinical values of the row
 * being deleted transmits PHI that serves no purpose.
 */

declare const operationId: OperationId;
declare const entityId: EntityId;
declare const clientTimestamp: WireInstant;
declare const payload: ObservationSyncPayload;

const deleteWithPayload: SyncDeleteOperation = {
  operationId,
  entityId,
  entityType: 'Observation',
  operationType: 'delete',
  clientTimestamp,
  // @ts-expect-error — a delete has no payload property (§3.1); a payload on a delete is a protocol error (§6.1).
  payload,
};
void deleteWithPayload;

const deleteWithPayloadViaTheUnion: SyncPushOperation = {
  operationId,
  entityId,
  entityType: 'Observation',
  operationType: 'delete',
  clientTimestamp,
  // @ts-expect-error — narrowed to the delete arm by `operationType` before the excess-property check runs.
  payload,
};
void deleteWithPayloadViaTheUnion;

// @ts-expect-error — a create without a payload is the mirror-image protocol error (§6.1).
const createWithoutPayload: SyncPushOperation = {
  operationId,
  entityId,
  entityType: 'Observation',
  operationType: 'create',
  clientTimestamp,
};
void createWithoutPayload;

// Both legitimate shapes typecheck with no suppression needed.
const legitimateDelete: SyncPushOperation = {
  operationId,
  entityId,
  entityType: 'Observation',
  operationType: 'delete',
  clientTimestamp,
};
const legitimateUpdate: SyncPushOperation = {
  operationId,
  entityId,
  entityType: 'Observation',
  operationType: 'update',
  clientTimestamp,
  payload,
};
void legitimateDelete;
void legitimateUpdate;
