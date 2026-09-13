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

import type { MeasurementSystem } from '@ostomy/core/units';
import type { CanonicalWireUnit } from '@ostomy/core/sync';

/**
 * The raw shape SQLite hands back from `getAllAsync`/`getFirstAsync` —
 * every column, `snake_case`, every value the type SQLite's dynamic typing
 * actually gives a driver (`string`, `number`, or `null`; SQLite has no
 * boolean or native timestamp type). Repository functions decode this into
 * the camelCase, branded, or literal-narrowed shapes below; nothing above
 * the repository layer should see a raw row.
 */
export interface ObservationRawRow {
  id: string;
  resource_type: string;
  code: string;
  value_quantity_value: string;
  value_quantity_unit: string;
  effective_datetime: string;
  method: string | null;
  status: string;
  entered_measurement_system: string;
  client_updated_at: string;
  server_sequence: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * The decoded local mirror of an `apps/api` `Observation` row / a
 * `docs/sync-contract.md` §7.2 `ObservationSyncPayload`, plus the local
 * bookkeeping columns (`createdAt`/`updatedAt`) that never cross the wire.
 *
 * `valueQuantityValue` stays a decimal **string** here — see
 * `./schema.ts`'s migration-1 comment for why — and is parsed to a `number`
 * only at the wire boundary (P2.S2b's job), never at rest.
 */
export interface LocalObservation {
  readonly id: string;
  readonly resourceType: 'Observation';
  readonly code: string;
  readonly valueQuantityValue: string;
  readonly valueQuantityUnit: CanonicalWireUnit;
  readonly effectiveDatetime: string;
  readonly method: string | null;
  readonly status: string;
  readonly enteredMeasurementSystem: MeasurementSystem;
  readonly clientUpdatedAt: string;
  /** `null` until this device has seen a push receipt or delta row naming this entity's server sequence (P2.S2b). */
  readonly serverSequence: string | null;
  /** Tombstone (mirrors `docs/sync-contract.md` §1): `null` = alive. */
  readonly deletedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function decodeObservationRow(row: ObservationRawRow): LocalObservation {
  return {
    id: row.id,
    resourceType: 'Observation',
    code: row.code,
    valueQuantityValue: row.value_quantity_value,
    valueQuantityUnit: row.value_quantity_unit as CanonicalWireUnit,
    effectiveDatetime: row.effective_datetime,
    method: row.method,
    status: row.status,
    enteredMeasurementSystem: decodeMeasurementSystem(row.entered_measurement_system),
    clientUpdatedAt: row.client_updated_at,
    serverSequence: row.server_sequence,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * The local schema's CHECK constraint already restricts this column to
 * these two values (`./schema.ts`) — this decode-boundary guard is what
 * lets `LocalObservation.enteredMeasurementSystem` be the real
 * `MeasurementSystem` union type rather than a bare `string`, following
 * the same "decode, don't cast" discipline `@ostomy/core/sync`'s
 * `toEntityId`/`toOperationId` use.
 */
function decodeMeasurementSystem(value: string): MeasurementSystem {
  if (value === 'metric' || value === 'imperial') return value;
  throw new TypeError(
    `observations.entered_measurement_system held an unrecognized value (this app's own CHECK constraint should have made this impossible; the database file is likely corrupt or was written by an incompatible schema version).`,
  );
}

export const SYNC_QUEUE_OPERATION_TYPE = ['create', 'update', 'delete'] as const;
export type SyncQueueOperationType = (typeof SYNC_QUEUE_OPERATION_TYPE)[number];

export const SYNC_QUEUE_STATUS = ['queued', 'in_flight', 'rejected'] as const;
export type SyncQueueStatus = (typeof SYNC_QUEUE_STATUS)[number];

/** Raw shape of a `sync_queue` row — see `ObservationRawRow`'s doc comment for why this layer exists. */
export interface SyncQueueRawRow {
  local_seq: number;
  operation_id: string;
  entity_type: string;
  entity_id: string;
  operation_type: string;
  client_timestamp: string;
  enqueued_at: string;
  status: string;
  attempt_count: number;
  last_attempted_at: string | null;
  rejected_reason_code: string | null;
  rejected_field: string | null;
  rejected_at: string | null;
}

/**
 * One row of the local sync queue — the shape `docs/sync-contract.md` §3.1
 * requires of a push operation, plus the local-only columns (`localSeq`,
 * `status`, `attemptCount`, `lastAttemptedAt`) that let P2.S2b's push loop
 * and correction inbox be built without a schema change.
 *
 * `localSeq` is `sync_queue`'s `AUTOINCREMENT` rowid — the true FIFO
 * enqueue order. It exists as a *separate* column from `operationId`
 * specifically so ordering never depends on `clientTimestamp` comparison
 * (equal timestamps are legal and resolved by array order per §3.2) or on
 * `operationId` (a UUID has no order at all). `operationId` is the
 * idempotency key (§1, §3.7); `localSeq` is the queue's own FIFO ordinal
 * and never crosses the wire.
 */
export interface SyncQueueEntry {
  readonly localSeq: number;
  readonly operationId: string;
  readonly entityType: 'Observation';
  readonly entityId: string;
  readonly operationType: SyncQueueOperationType;
  readonly clientTimestamp: string;
  readonly enqueuedAt: string;
  readonly status: SyncQueueStatus;
  readonly attemptCount: number;
  readonly lastAttemptedAt: string | null;
  readonly rejectedReasonCode: string | null;
  readonly rejectedField: string | null;
  readonly rejectedAt: string | null;
}

export function decodeSyncQueueRow(row: SyncQueueRawRow): SyncQueueEntry {
  return {
    localSeq: row.local_seq,
    operationId: row.operation_id,
    entityType: decodeEntityType(row.entity_type),
    entityId: row.entity_id,
    operationType: decodeOperationType(row.operation_type),
    clientTimestamp: row.client_timestamp,
    enqueuedAt: row.enqueued_at,
    status: decodeQueueStatus(row.status),
    attemptCount: row.attempt_count,
    lastAttemptedAt: row.last_attempted_at,
    rejectedReasonCode: row.rejected_reason_code,
    rejectedField: row.rejected_field,
    rejectedAt: row.rejected_at,
  };
}

function decodeEntityType(value: string): 'Observation' {
  if (value === 'Observation') return value;
  throw new TypeError(
    'sync_queue.entity_type held a value other than "Observation" — P2.S2a writes no other entity type.',
  );
}

function decodeOperationType(value: string): SyncQueueOperationType {
  if ((SYNC_QUEUE_OPERATION_TYPE as readonly string[]).includes(value)) {
    return value as SyncQueueOperationType;
  }
  throw new TypeError(
    'sync_queue.operation_type held a value outside the schema CHECK constraint.',
  );
}

function decodeQueueStatus(value: string): SyncQueueStatus {
  if ((SYNC_QUEUE_STATUS as readonly string[]).includes(value)) {
    return value as SyncQueueStatus;
  }
  throw new TypeError('sync_queue.status held a value outside the schema CHECK constraint.');
}
