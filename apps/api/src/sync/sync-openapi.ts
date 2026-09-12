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
 * The OpenAPI schemas the sync endpoints publish.
 *
 * Written for the same reason as `observations/observation-openapi.ts`, and
 * added late for a reason worth recording: without these, `SyncController`
 * carried only `@ApiOperation`, so the generator emitted
 *
 *     push: () => Promise<void>
 *     delta: () => Promise<void>
 *
 * — a `push` that sends no body and returns nothing, and a `delta` that
 * cannot pass `since`, which is required. `packages/core/src/api-client` is
 * what `apps/mobile` (P2.S2) compiles against, so the typed client for the
 * only protocol that app speaks was unusable. The stale-client check added at
 * P2.S1a did not catch it: it proves the client matches the document, and the
 * document was faithfully describing an under-annotated controller.
 *
 * Derived from `packages/core/src/sync`'s own vocabulary rather than
 * restated, so the published schema cannot drift from the contract types.
 * `docs/sync-contract.md` governs both.
 */
import {
  SYNC_ENTITY_TYPE,
  SYNC_FIELD_PATH,
  SYNC_OPERATION_TYPE,
  SYNC_PROTOCOL_ERROR_CODE,
  SYNC_REASON_CODE,
  SYNC_RESULT_STATUS,
} from '@ostomy/core/sync';
import { z } from 'zod';

import { observationResourceSchema } from '../observations/observation-wire';

const wireInstant = z.string().describe('RFC 3339, UTC, exactly three fractional digits (§7.3).');

/**
 * `serverSequence` and `appliedServerSequence` are STRINGS on the wire (§7.3)
 * — they are 64-bit and `JSON.parse` silently loses precision above 2^53.
 * Published as strings so a generated client cannot decide otherwise.
 */
const serverSequence = z
  .string()
  .describe('A server sequence. A JSON string, never a number — 64-bit (§7.3).');

const pushOperationSchema = z
  .strictObject({
    operationId: z.uuid().describe('Client-generated at enqueue. Never the entity id (§1).'),
    entityType: z.enum(Object.values(SYNC_ENTITY_TYPE)),
    entityId: z.uuid(),
    operationType: z.enum(Object.values(SYNC_OPERATION_TYPE)),
    clientTimestamp: wireInstant.describe(
      'When the WRITE was made. Orders the batch and decides last-write-wins — distinct from effectiveDateTime, the clinical moment (§1).',
    ),
    payload: observationResourceSchema
      .optional()
      .describe('Absent for a delete, required otherwise (§3.1).'),
  })
  .meta({ title: 'SyncPushOperation' });

export const syncPushRequestSchema = z
  .strictObject({
    operations: z
      .array(pushOperationSchema)
      .describe(
        'Applied in array order, and MUST be non-descending in clientTimestamp (§3.2). At most SYNC_PUSH_MAX_OPERATIONS (§3.3).',
      ),
  })
  .meta({ title: 'SyncPushRequest' });

/**
 * One result. Modelled as a single object with optional arms rather than a
 * discriminated union, because `z.toJSONSchema` would emit `oneOf` and the
 * generated client renders that as a union whose members a caller must
 * narrow — which is right, but the narrowing helpers already live in
 * `packages/core/src/sync` (`isAcceptedResult`, `isRejectedResult`, ...) and
 * are what a client should use. Publishing the widened shape keeps the
 * document honest about the key set without inviting a second, generated
 * narrowing vocabulary that would drift from those helpers.
 */
const pushResultSchema = z
  .strictObject({
    operationId: z.uuid(),
    status: z.enum(Object.values(SYNC_RESULT_STATUS)),
    entityId: z.uuid(),
    appliedServerSequence: serverSequence
      .optional()
      .describe(
        'Present on accepted and superseded, absent on rejected. A RECEIPT, never a cursor — a client MUST NOT advance its delta cursor from it (§3.6).',
      ),
    reasonCode: z
      .enum(Object.values(SYNC_REASON_CODE))
      .optional()
      .describe('Present only on rejected. Never carries the offending value (§6.3).'),
    field: z
      .enum(Object.values(SYNC_FIELD_PATH))
      .optional()
      .describe('Present only on rejected. A closed set (§6.2).'),
    replayed: z
      .boolean()
      .describe('Diagnostic. A client MUST NOT branch clinical behaviour on it (§3.7).'),
  })
  .meta({ title: 'SyncOperationResult' });

export const syncPushResponseSchema = z
  .strictObject({ results: z.array(pushResultSchema) })
  .meta({ title: 'SyncPushResponse' });

const deltaChangeSchema = z
  .strictObject({
    entityType: z.enum(Object.values(SYNC_ENTITY_TYPE)),
    entityId: z.uuid(),
    serverSequence,
    deleted: z.boolean(),
    clientUpdatedAt: wireInstant.describe(
      'For a tombstone, the client timestamp of the operation that DELETED the row — not a server receipt time (§5.2).',
    ),
    payload: observationResourceSchema
      .optional()
      .describe('Absent entirely on a tombstone — not null, not empty (§5.2).'),
  })
  .meta({ title: 'SyncDeltaChange' });

export const syncDeltaResponseSchema = z
  .strictObject({
    changes: z.array(deltaChangeSchema).describe('Ordered by serverSequence ascending.'),
    cursor: serverSequence.describe(
      'The highest sequence the server is willing to let the client advance to — not necessarily the highest in changes, and never derived by the client from the rows it received (§5.2).',
    ),
    hasMore: z
      .boolean()
      .describe(
        'About THIS PAGE, not the server high-water mark. Always false when changes is empty (§5.2).',
      ),
  })
  .meta({ title: 'SyncDeltaResponse' });

export const syncProtocolErrorSchema = z
  .strictObject({
    error: z.strictObject({ code: z.enum(Object.values(SYNC_PROTOCOL_ERROR_CODE)) }),
  })
  .meta({ title: 'SyncProtocolErrorResponse' });

export type OpenApiSchemaObject = Record<string, unknown>;

function toOpenApiSchema(schema: z.ZodType): OpenApiSchemaObject {
  return z.toJSONSchema(schema, { target: 'openapi-3.0' }) as OpenApiSchemaObject;
}

export const SYNC_PUSH_REQUEST_SCHEMA = toOpenApiSchema(syncPushRequestSchema);
export const SYNC_PUSH_RESPONSE_SCHEMA = toOpenApiSchema(syncPushResponseSchema);
export const SYNC_DELTA_RESPONSE_SCHEMA = toOpenApiSchema(syncDeltaResponseSchema);
export const SYNC_PROTOCOL_ERROR_SCHEMA = toOpenApiSchema(syncProtocolErrorSchema);
