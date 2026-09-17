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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiError } from '@ostomy/core/api-client';
import type { SyncDeltaResponse, SyncPushResponse } from '@ostomy/core/api-client';
import type { SyncPushRequest } from '@ostomy/core/sync';

import type { SqliteExecutor } from '../db/executor';
import { enqueueVolumetricObservationCreate } from '../db/offlineWrites';
import { getObservationById } from '../db/repositories/observationsRepository';
import { getCursor } from '../db/repositories/syncCursorRepository';
import {
  listQueuedOperations,
  listRejectedOperations,
} from '../db/repositories/syncQueueRepository';
import { runMigrations } from '../db/migrations';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { runSyncCycle, type SyncClientPort } from './syncWorker';

const STOMA_OUTPUT_CODE = '79560-9';
const FIXED_NOW = () => new Date('2026-09-15T12:00:00.000Z');

/**
 * A recording stand-in for the generated client. Deliberately not a mock of
 * `createApiClient`: these tests assert what goes ON THE WIRE, so the double
 * has to capture the exact request object the worker built.
 */
function createClientDouble(): {
  port: SyncClientPort;
  pushes: SyncPushRequest[];
  deltaQueries: { since: string; limit?: string }[];
  pushResponses: (SyncPushResponse | Error)[];
  deltaResponses: (SyncDeltaResponse | Error)[];
  thresholdResponses: ({ stomaOutputSoftWarningMl: number; maxClockSkewMs: number } | Error)[];
} {
  const pushes: SyncPushRequest[] = [];
  const deltaQueries: { since: string; limit?: string }[] = [];
  const pushResponses: (SyncPushResponse | Error)[] = [];
  const deltaResponses: (SyncDeltaResponse | Error)[] = [];
  const thresholdResponses: (
    { stomaOutputSoftWarningMl: number; maxClockSkewMs: number } | Error
  )[] = [];

  const port: SyncClientPort = {
    push: (request) => {
      pushes.push(request as SyncPushRequest);
      const next = pushResponses.shift() ?? { results: [] };
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    delta: (query) => {
      deltaQueries.push(query);
      const next =
        deltaResponses.shift() ??
        ({ changes: [], cursor: '0', hasMore: false } as unknown as SyncDeltaResponse);
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
    thresholds: () => {
      const next = thresholdResponses.shift() ?? {
        stomaOutputSoftWarningMl: 2000,
        maxClockSkewMs: 300_000,
      };
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    },
  };

  return { port, pushes, deltaQueries, pushResponses, deltaResponses, thresholdResponses };
}

function protocolError(status: number, code: string): ApiError {
  return new ApiError(status, { error: { code } });
}

describe('runSyncCycle', () => {
  let dir: string;
  let executor: SqliteExecutor;
  let client: ReturnType<typeof createClientDouble>;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-sync-worker-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
    client = createClientDouble();
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  async function writeEntry(
    value: string,
    at: string,
  ): Promise<{ id: string; operationId: string }> {
    return enqueueVolumetricObservationCreate(
      executor,
      {
        code: STOMA_OUTPUT_CODE,
        valueQuantityValue: value,
        valueQuantityUnit: 'mL',
        effectiveDatetime: at,
        measuredOrEstimated: 'measured',
        enteredMeasurementSystem: 'metric',
      },
      () => new Date(at),
    );
  }

  function deps(overrides: Partial<Parameters<typeof runSyncCycle>[0]> = {}) {
    return {
      executor,
      client: client.port,
      now: FIXED_NOW,
      maxOperationsPerBatch: 500,
      ...overrides,
    };
  }

  describe('the push payload', () => {
    it('sends the §7.2 fields and nothing else — no localDate, no serverSequence, no bookkeeping', async () => {
      const { id } = await writeEntry('350', '2026-09-15T11:00:00.000Z');
      client.pushResponses.push({
        results: [
          {
            operationId: (await listQueuedOperations(executor))[0]!.operationId,
            entityId: id,
            status: 'accepted',
            appliedServerSequence: '48213',
            replayed: false,
          },
        ],
      } as unknown as SyncPushResponse);

      await runSyncCycle(deps());

      const payload = client.pushes[0]!.operations[0] as unknown as {
        payload: Record<string, unknown>;
      };
      expect(Object.keys(payload.payload).sort()).toEqual([
        'code',
        'effectiveDateTime',
        'enteredMeasurementSystem',
        'enteredTimezone',
        'id',
        'method',
        'resourceType',
        'status',
        'valueQuantity',
      ]);
      // §7.2 names all three as PAYLOAD_FIELD_UNRECOGNIZED, and localDate
      // additionally as a second source of truth nothing would detect.
      expect(payload.payload).not.toHaveProperty('localDate');
      expect(payload.payload).not.toHaveProperty('serverSequence');
      expect(payload.payload).not.toHaveProperty('deletedAt');
    });

    it('sends valueQuantity.value as a JSON number while the column keeps the decimal string (§7.3)', async () => {
      await writeEntry('350.2500', '2026-09-15T11:00:00.000Z');

      await runSyncCycle(deps());

      const payload = client.pushes[0]!.operations[0] as unknown as {
        payload: { valueQuantity: { value: unknown } };
      };
      expect(typeof payload.payload.valueQuantity.value).toBe('number');
      expect(payload.payload.valueQuantity.value).toBe(350.25);
    });
  });

  describe('result handling (§3.5)', () => {
    it('removes an accepted operation and stamps the entity server sequence', async () => {
      const { id } = await writeEntry('350', '2026-09-15T11:00:00.000Z');
      const operationId = (await listQueuedOperations(executor))[0]!.operationId;
      client.pushResponses.push({
        results: [
          {
            operationId,
            entityId: id,
            status: 'accepted',
            appliedServerSequence: '48213',
            replayed: false,
          },
        ],
      } as unknown as SyncPushResponse);

      const result = await runSyncCycle(deps());

      expect(result.push.accepted).toBe(1);
      expect(await listQueuedOperations(executor)).toHaveLength(0);
      expect((await getObservationById(executor, id))?.serverSequence).toBe('48213');
    });

    it('removes a superseded operation without sending it to the correction inbox', async () => {
      const { id } = await writeEntry('350', '2026-09-15T11:00:00.000Z');
      const operationId = (await listQueuedOperations(executor))[0]!.operationId;
      client.pushResponses.push({
        results: [
          {
            operationId,
            entityId: id,
            status: 'superseded',
            appliedServerSequence: '48198',
            replayed: false,
          },
        ],
      } as unknown as SyncPushResponse);

      const result = await runSyncCycle(deps());

      expect(result.push.superseded).toBe(1);
      expect(await listQueuedOperations(executor)).toHaveLength(0);
      // The entry was never wrong; asking the patient to fix it would be
      // the failure §3.5 introduced `superseded` to avoid.
      expect(await listRejectedOperations(executor)).toHaveLength(0);
    });

    /** AC 13.1 AC4, and §9.1: retained and surfaced, never dropped. */
    it('retains a rejected operation for correction rather than dropping it', async () => {
      const { id } = await writeEntry('350', '2026-09-15T11:00:00.000Z');
      const operationId = (await listQueuedOperations(executor))[0]!.operationId;
      client.pushResponses.push({
        results: [
          {
            operationId,
            entityId: id,
            status: 'rejected',
            reasonCode: 'VALUE_NOT_POSITIVE',
            field: 'valueQuantity.value',
            replayed: false,
          },
        ],
      } as unknown as SyncPushResponse);

      const result = await runSyncCycle(deps());

      expect(result.push.rejected).toBe(1);
      const rejected = await listRejectedOperations(executor);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.rejectedReasonCode).toBe('VALUE_NOT_POSITIVE');
      expect(rejected[0]!.rejectedField).toBe('valueQuantity.value');
      // The patient's entry itself survives: only the operation is parked.
      expect(await getObservationById(executor, id)).toBeDefined();
    });

    /** §9.2: a rejected operation is never resubmitted unchanged. */
    it('does not re-push a rejected operation on the next cycle', async () => {
      const { id } = await writeEntry('350', '2026-09-15T11:00:00.000Z');
      const operationId = (await listQueuedOperations(executor))[0]!.operationId;
      client.pushResponses.push({
        results: [
          {
            operationId,
            entityId: id,
            status: 'rejected',
            reasonCode: 'VALUE_NOT_POSITIVE',
            field: 'valueQuantity.value',
            replayed: false,
          },
        ],
      } as unknown as SyncPushResponse);

      await runSyncCycle(deps());
      const pushesAfterFirst = client.pushes.length;
      await runSyncCycle(deps());

      expect(client.pushes).toHaveLength(pushesAfterFirst);
    });

    /**
     * Position-correlation would settle the wrong rows here and leave both
     * well-formed afterwards, so nothing downstream could detect it.
     */
    it('correlates results by operationId, not by array position', async () => {
      const first = await writeEntry('100', '2026-09-15T11:00:00.000Z');
      const second = await writeEntry('200', '2026-09-15T11:01:00.000Z');
      const queued = await listQueuedOperations(executor);

      client.pushResponses.push({
        results: [
          // Deliberately reversed relative to request order.
          {
            operationId: queued[1]!.operationId,
            entityId: second.id,
            status: 'accepted',
            appliedServerSequence: '2',
            replayed: false,
          },
          {
            operationId: queued[0]!.operationId,
            entityId: first.id,
            status: 'rejected',
            reasonCode: 'VALUE_NOT_POSITIVE',
            field: 'valueQuantity.value',
            replayed: false,
          },
        ],
      } as unknown as SyncPushResponse);

      await runSyncCycle(deps());

      const rejected = await listRejectedOperations(executor);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.operationId).toBe(queued[0]!.operationId);
      expect((await getObservationById(executor, second.id))?.serverSequence).toBe('2');
    });

    it('returns an operation the response never named to the queue rather than stranding it in flight', async () => {
      await writeEntry('100', '2026-09-15T11:00:00.000Z');
      await writeEntry('200', '2026-09-15T11:01:00.000Z');
      const queued = await listQueuedOperations(executor);
      client.pushResponses.push({
        results: [
          {
            operationId: queued[0]!.operationId,
            entityId: queued[0]!.entityId,
            status: 'accepted',
            appliedServerSequence: '1',
            replayed: false,
          },
        ],
      } as unknown as SyncPushResponse);

      await runSyncCycle(deps());

      const stillQueued = await listQueuedOperations(executor);
      expect(stillQueued.map((operation) => operation.operationId)).toEqual([
        queued[1]!.operationId,
      ]);
    });
  });

  describe('failures whose outcome is unknown (§9.3)', () => {
    it('returns the batch to the queue on a network failure instead of rejecting it', async () => {
      await writeEntry('350', '2026-09-15T11:00:00.000Z');
      client.pushResponses.push(new Error('network request failed'));

      const result = await runSyncCycle(deps());

      expect(result.stoppedBecause).toEqual({ kind: 'unavailable' });
      expect(await listQueuedOperations(executor)).toHaveLength(1);
      expect(await listRejectedOperations(executor)).toHaveLength(0);
    });

    it('returns the batch to the queue on a 5xx instead of rejecting it', async () => {
      await writeEntry('350', '2026-09-15T11:00:00.000Z');
      client.pushResponses.push(new ApiError(503, undefined));

      const result = await runSyncCycle(deps());

      expect(result.stoppedBecause).toEqual({ kind: 'unavailable' });
      expect(await listQueuedOperations(executor)).toHaveLength(1);
      expect(await listRejectedOperations(executor)).toHaveLength(0);
    });

    it('re-pushes after a failed attempt, letting idempotency settle the first one', async () => {
      const { id } = await writeEntry('350', '2026-09-15T11:00:00.000Z');
      const operationId = (await listQueuedOperations(executor))[0]!.operationId;
      client.pushResponses.push(new Error('network request failed'));
      client.pushResponses.push({
        results: [
          {
            operationId,
            entityId: id,
            status: 'accepted',
            appliedServerSequence: '48213',
            replayed: true,
          },
        ],
      } as unknown as SyncPushResponse);

      await runSyncCycle(deps());
      const result = await runSyncCycle(deps());

      expect(result.push.accepted).toBe(1);
      // The SAME operation id both times: §9.7 — minted once at enqueue,
      // never re-minted for a retry, which is the only thing standing
      // between a retry and a duplicate row.
      const sentIds = client.pushes.map(
        (request) => (request.operations[0] as unknown as { operationId: string }).operationId,
      );
      expect(sentIds[0]).toBe(sentIds[1]);
    });

    it('stops without touching the queue when there is no access token', async () => {
      await writeEntry('350', '2026-09-15T11:00:00.000Z');
      client.pushResponses.push(protocolError(401, 'UNAUTHENTICATED'));

      const result = await runSyncCycle(deps());

      expect(result.stoppedBecause).toEqual({ kind: 'unauthenticated' });
      expect(await listQueuedOperations(executor)).toHaveLength(1);
      expect(await listRejectedOperations(executor)).toHaveLength(0);
    });
  });

  describe('protocol errors (§6.1)', () => {
    /**
     * §3.3's own prescribed recovery. A smaller request is a CHANGED
     * request, so this is not the forbidden unchanged retry — and it means
     * the client recovers on its own when an operator lowers
     * SYNC_PUSH_MAX_OPERATIONS below what this build was configured with.
     */
    it('splits and re-pushes on BATCH_TOO_LARGE rather than stalling', async () => {
      await writeEntry('100', '2026-09-15T11:00:00.000Z');
      await writeEntry('200', '2026-09-15T11:01:00.000Z');
      const queued = await listQueuedOperations(executor);

      client.pushResponses.push(protocolError(413, 'BATCH_TOO_LARGE'));
      client.pushResponses.push({
        results: [
          {
            operationId: queued[0]!.operationId,
            entityId: queued[0]!.entityId,
            status: 'accepted',
            appliedServerSequence: '1',
            replayed: false,
          },
        ],
      } as unknown as SyncPushResponse);
      client.pushResponses.push({
        results: [
          {
            operationId: queued[1]!.operationId,
            entityId: queued[1]!.entityId,
            status: 'accepted',
            appliedServerSequence: '2',
            replayed: false,
          },
        ],
      } as unknown as SyncPushResponse);

      const result = await runSyncCycle(deps());

      expect(result.push.accepted).toBe(2);
      expect(await listQueuedOperations(executor)).toHaveLength(0);
      expect(client.pushes).toHaveLength(3);
    });

    /**
     * The failure the naive reading of §6.1 produces: one malformed row from
     * one app version silently stranding every entry the patient makes
     * afterwards. Isolation is what keeps "retain the whole batch" and "do
     * not retry it unchanged" from jointly stalling the queue forever.
     */
    it('isolates the offending operation and drains the rest of the queue', async () => {
      const first = await writeEntry('100', '2026-09-15T11:00:00.000Z');
      await writeEntry('200', '2026-09-15T11:01:00.000Z');
      const queued = await listQueuedOperations(executor);

      // The whole batch fails, then the first operation fails alone, then
      // the second succeeds on its own.
      client.pushResponses.push(protocolError(400, 'ENTITY_ID_MISMATCH'));
      client.pushResponses.push(protocolError(400, 'ENTITY_ID_MISMATCH'));
      client.pushResponses.push({
        results: [
          {
            operationId: queued[1]!.operationId,
            entityId: queued[1]!.entityId,
            status: 'accepted',
            appliedServerSequence: '2',
            replayed: false,
          },
        ],
      } as unknown as SyncPushResponse);

      const result = await runSyncCycle(deps());

      expect(result.quarantined).toBe(1);
      expect(result.push.accepted).toBe(1);
      expect(await listQueuedOperations(executor)).toHaveLength(0);

      const rejected = await listRejectedOperations(executor);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.entityId).toBe(first.id);
      expect(rejected[0]!.rejectedReasonCode).toBe('ENTITY_ID_MISMATCH');
      // §6.1 bodies carry no field path; inventing one would be the echoed
      // diagnostic that section forbids.
      expect(rejected[0]!.rejectedField).toBeNull();
    });
  });

  describe('the delta cursor', () => {
    /** §3.6 / §9.4: the cursor comes from a delta response and from nowhere else. */
    it('is never advanced by a push receipt', async () => {
      const { id } = await writeEntry('350', '2026-09-15T11:00:00.000Z');
      const operationId = (await listQueuedOperations(executor))[0]!.operationId;
      client.pushResponses.push({
        results: [
          {
            operationId,
            entityId: id,
            status: 'accepted',
            appliedServerSequence: '48213',
            replayed: false,
          },
        ],
      } as unknown as SyncPushResponse);
      client.deltaResponses.push({
        changes: [],
        cursor: '0',
        hasMore: false,
      } as unknown as SyncDeltaResponse);

      await runSyncCycle(deps());

      expect(await getCursor(executor)).toBe('0');
    });

    it('advances only from the delta response, page by page', async () => {
      client.deltaResponses.push({
        changes: [],
        cursor: '10',
        hasMore: true,
      } as unknown as SyncDeltaResponse);
      client.deltaResponses.push({
        changes: [],
        cursor: '20',
        hasMore: false,
      } as unknown as SyncDeltaResponse);

      const result = await runSyncCycle(deps());

      expect(result.delta.pages).toBe(2);
      expect(client.deltaQueries.map((query) => query.since)).toEqual(['0', '10']);
      expect(await getCursor(executor)).toBe('20');
    });

    it('reports CURSOR_TOO_OLD rather than silently wiping local entries', async () => {
      client.deltaResponses.push(protocolError(409, 'CURSOR_TOO_OLD'));

      const result = await runSyncCycle(deps());

      expect(result.stoppedBecause).toEqual({ kind: 'cursor-too-old' });
      // The recovery destroys local rows, so it is the app's call, not a
      // background worker's.
      expect(await getCursor(executor)).toBe('0');
    });

    it('stops instead of spinning when a server reports hasMore without advancing', async () => {
      client.deltaResponses.push({
        changes: [],
        cursor: '0',
        hasMore: true,
      } as unknown as SyncDeltaResponse);

      const result = await runSyncCycle(deps());

      expect(result.stoppedBecause).toEqual({ kind: 'unavailable' });
      expect(client.deltaQueries).toHaveLength(1);
    });
  });

  describe('ordering across the whole cycle', () => {
    it('pushes before it pulls, so the pull compares against settled state', async () => {
      await writeEntry('350', '2026-09-15T11:00:00.000Z');
      const order: string[] = [];
      const port: SyncClientPort = {
        push: (request) => {
          order.push('push');
          return client.port.push(request);
        },
        delta: (query) => {
          order.push('delta');
          return client.port.delta(query);
        },
        thresholds: () => client.port.thresholds(),
      };

      await runSyncCycle(deps({ client: port }));

      expect(order[0]).toBe('push');
      expect(order).toContain('delta');
    });

    it('splits a clock-correction discontinuity into separate requests (§3.2)', async () => {
      await writeEntry('100', '2026-09-15T11:00:00.000Z');
      await writeEntry('200', '2026-09-15T09:00:00.000Z');

      await runSyncCycle(deps());

      expect(client.pushes).toHaveLength(2);
      expect(client.pushes[0]!.operations).toHaveLength(1);
      expect(client.pushes[1]!.operations).toHaveLength(1);
    });
  });
});
