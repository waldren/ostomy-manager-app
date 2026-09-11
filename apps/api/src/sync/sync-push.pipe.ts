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

import { Inject, Injectable, type PipeTransform } from '@nestjs/common';
import { SYNC_ENTITY_TYPE, SYNC_OPERATION_TYPE } from '@ostomy/core/sync';
import { z } from 'zod';

import { APP_CONFIG } from '../config/config.tokens';
import type { AppConfig } from '../config/env.schema';
import {
  batchOutOfOrder,
  batchTooLarge,
  entityIdMismatch,
  malformedRequest,
  payloadPresenceInvalid,
} from './sync-protocol.error';

/**
 * Decodes a push request into its operations, enforcing every
 * **request-level and operation-level** rule — and deliberately none of the
 * payload-content rules.
 *
 * ## The line this pipe must not cross
 *
 * `docs/sync-contract.md` §6.1 is explicit: "anything about the *content* of
 * a payload field" is a data error that fails **one operation**, not a `400`
 * that fails the batch. Escalating one is how "a batch never fails as a unit"
 * turns back into the all-or-nothing batching ADR-0001 rejected — one bad row
 * from an old app version blocking every entry a patient made while offline.
 *
 * §6.1 names the mechanism that gets this wrong: "a whole-body DTO validator
 * applied to the operations array does exactly that." So `payload` is typed
 * here as an opaque object and is **not** parsed. `SyncPushService` validates
 * each one per operation, and a failure there produces a `rejected` result
 * inside a `200`.
 *
 * The two payload rules that ARE here are structural rather than content:
 * presence (§3.1 — required except on a delete) and `payload.id` matching
 * the operation's `entityId` (§7.2). Neither inspects a clinical value, and
 * §6.1's table lists both as protocol errors by name.
 *
 * ## Whitelist-strict, because a type is not a parser
 *
 * §2 requires rejection of any key not named in the contract, at request and
 * operation level. The TypeScript types have no `patientId` property, but a
 * type does not exist at the JSON decode boundary — `.strict()` is what
 * enforces it. An extra key here is `MALFORMED_REQUEST`; an extra key inside
 * a *payload* is `PAYLOAD_FIELD_UNRECOGNIZED` and belongs to the per-operation
 * path, because only the second is something a newer client might have meant
 * to send.
 *
 * ## Nothing from zod reaches a response
 *
 * Every failure below throws a `SyncProtocolException` carrying a bare code.
 * zod's own `message` names the offending key and often its value, and §6.1
 * forbids prose, field paths, echoed content, and even an index into the
 * offending operation. So the parse result's `error` is discarded entirely
 * rather than inspected — the only thing read off it is that it failed.
 */
@Injectable()
export class SyncPushPipe implements PipeTransform<unknown, SyncPushRequestParsed> {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  transform(value: unknown): SyncPushRequestParsed {
    const parsed = pushRequestSchema.safeParse(value);
    if (!parsed.success) {
      throw malformedRequest();
    }

    const { operations } = parsed.data;

    // §3.3. Checked before anything per-operation: the point of a bound is to
    // avoid doing unbounded work, so validating 10,000 operations to discover
    // there are too many defeats it.
    if (operations.length > this.config.syncPushMaxOperations) {
      throw batchTooLarge();
    }

    assertUniqueOperationIds(operations);
    assertNonDescending(operations);

    return { operations: operations.map(toParsedOperation) };
  }
}

/**
 * Operation-level shape only. `payload` is `z.record(z.unknown())` — an
 * object, contents unexamined — for the reason in the class comment above.
 */
const operationSchema = z
  .object({
    operationId: z.uuid(),
    entityType: z.enum(Object.values(SYNC_ENTITY_TYPE) as [string, ...string[]]),
    entityId: z.uuid(),
    operationType: z.enum(Object.values(SYNC_OPERATION_TYPE) as [string, ...string[]]),
    // §7.3's lexical form, pinned rather than parsed leniently: "accept it
    // and truncate" turns a client bug into silent precision loss inside the
    // values conflict resolution compares.
    clientTimestamp: z.iso.datetime({ precision: 3 }),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const pushRequestSchema = z.object({ operations: z.array(operationSchema) }).strict();

type RawOperation = z.infer<typeof operationSchema>;

/** One decoded operation. `payload` stays opaque — see `SyncPushPipe`. */
export interface SyncPushOperationParsed {
  readonly operationId: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly operationType: string;
  readonly clientTimestamp: Date;
  readonly payload: Record<string, unknown> | undefined;
}

export interface SyncPushRequestParsed {
  readonly operations: readonly SyncPushOperationParsed[];
}

/**
 * §3.7. Two operations sharing an `operationId` is `MALFORMED_REQUEST` for
 * the whole request, **not** a replay of the first.
 *
 * An id is minted once at enqueue (§9.7), so two in one batch means the
 * client's queue is broken — and treating the second as a replay would
 * silently discard a write the client believed it had sent, which is the
 * failure this protocol spends most of its complexity avoiding.
 */
function assertUniqueOperationIds(operations: readonly RawOperation[]): void {
  const seen = new Set<string>();
  for (const operation of operations) {
    if (seen.has(operation.operationId)) {
      throw malformedRequest();
    }
    seen.add(operation.operationId);
  }
}

/**
 * §3.2. The array MUST be non-descending in `clientTimestamp`.
 *
 * A protocol error rather than a per-operation rejection because the server
 * cannot repair it: reordering is precisely what §9.6 forbids it to do, and
 * there is nothing a patient could correct.
 *
 * Note what this does NOT mean. A descending local queue is not necessarily a
 * client bug — an NTP correction or a user fixing their phone's clock
 * produces a locally correct queue that is descending across the
 * discontinuity. §3.2 puts the obligation on the client to split the batch at
 * each discontinuity and push the runs in order, which is why refusing here
 * is not a dead end for the patient's backlog.
 *
 * Equal timestamps are permitted and resolved by array order (§3.2): the
 * client queued them in that order and is the only authority on it.
 */
function assertNonDescending(operations: readonly RawOperation[]): void {
  for (let index = 1; index < operations.length; index += 1) {
    const previous = Date.parse(operations[index - 1]!.clientTimestamp);
    const current = Date.parse(operations[index]!.clientTimestamp);
    if (current < previous) {
      throw batchOutOfOrder();
    }
  }
}

/**
 * §3.1 payload presence and §7.2's `payload.id` equality.
 *
 * Both are structural: neither reads a clinical value, and §6.1 lists both as
 * protocol errors by name (`PAYLOAD_PRESENCE_INVALID`, `ENTITY_ID_MISMATCH`).
 */
function toParsedOperation(operation: RawOperation): SyncPushOperationParsed {
  const isDelete = operation.operationType === SYNC_OPERATION_TYPE.DELETE;

  if (isDelete && operation.payload !== undefined) {
    throw payloadPresenceInvalid();
  }
  if (!isDelete && operation.payload === undefined) {
    throw payloadPresenceInvalid();
  }

  if (operation.payload !== undefined && operation.payload.id !== operation.entityId) {
    // Compared, never echoed. §7.2 puts `id` in the payload because FHIR does;
    // a mismatch between the two identifiers is a client bug with nothing to
    // correct, so it fails the request rather than one operation.
    throw entityIdMismatch();
  }

  return {
    operationId: operation.operationId,
    entityType: operation.entityType,
    entityId: operation.entityId,
    operationType: operation.operationType,
    clientTimestamp: new Date(operation.clientTimestamp),
    payload: operation.payload,
  };
}
