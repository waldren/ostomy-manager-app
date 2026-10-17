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
 * Target ranges on this device, through sync (P4.S3 slice 4,
 * `docs/sync-contract.md` §7.6): a change queued with its row, built into a
 * push at push time, settled by the push, and the cached server answer that the
 * screen lays the changes over until a newer answer reflects them.
 *
 * Against a real SQLite database through the real migrations, because what
 * matters is which rows and operations exist after each step.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncDeltaResponse, SyncPushResponse } from '@ostomy/core/api-client';

import type { SqliteExecutor } from '../db/executor';
import { runMigrations } from '../db/migrations';
import {
  discardRejectedRangeWrite,
  enqueueRangeCreate,
  enqueueRangeStatusChange,
} from '../db/offlineWrites';
import {
  decodeRanges,
  getRangeWriteForOperation,
  listOverlayRangeWrites,
  listSettledRangeWriteOperations,
  readRangeCache,
  replaceRangeCache,
} from '../db/repositories/rangesRepository';
import { getCursor } from '../db/repositories/syncCursorRepository';
import {
  listQueuedOperations,
  markRejected,
  recordAttempt,
  revertToQueued,
} from '../db/repositories/syncQueueRepository';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { applyDeltaPage } from './deltaPull';
import { applyPushResults, buildPushRequest } from './pushOperations';
import { decodeDeltaPage, decodePushResults } from './responseDecoding';

const AT = (minute: number) => () => new Date(Date.UTC(2026, 9, 17, 12, minute));
const iso = (minute: number) => AT(minute)().toISOString();
const STORED_ID = '44444444-4444-4444-8444-444444444444';

/** A delete carries no payload (§3.1), so the type makes reading one explicit. */
function payloadOf(operation: unknown): { status: string } & Record<string, unknown> {
  return (operation as { payload: { status: string } & Record<string, unknown> }).payload;
}

const STORED_ROW = {
  id: STORED_ID,
  rangeType: 'daily_output_ml',
  lowValue: 700,
  highValue: null,
  targetValue: null,
  unit: 'mL',
  provenance: 'patient_confirmed_suggestion' as const,
};

/** One range as `GET /api/v1/ranges` sends it. */
const READ_RESPONSE_RANGE = {
  rangeType: 'daily_output_ml',
  unit: 'mL',
  lowValue: 700,
  highValue: 1400,
  provenance: 'PATIENT_SET',
  isActiveThreshold: true,
  divergesFromPhysician: false,
  basis: {
    ostomyType: 'ileostomy',
    daysPostOp: 10,
    minDaysPostOp: 0,
    maxDaysPostOp: 30,
    lowValue: 600,
    highValue: 1500,
  },
  patientRange: {
    id: STORED_ID,
    lowValue: 700,
    highValue: 1400,
    targetValue: null,
    unit: 'mL',
    provenance: 'PATIENT_SET',
  },
  proposal: null,
  limits: { minValue: 0.0001, maxValue: 99999999.9999 },
};

describe('target ranges on this device, through sync (P4.S3 slice 4, §7.6)', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-range-sync-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, AT(0));
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  function newValue(minute = 1) {
    return enqueueRangeCreate(
      executor,
      {
        rangeType: 'daily_output_ml',
        lowValue: '800',
        highValue: '1600.5',
        unit: 'mL',
        provenance: 'patient_set',
      },
      AT(minute),
    );
  }

  async function pushedStatuses(): Promise<[string, string][]> {
    const built = await buildPushRequest(executor, await listQueuedOperations(executor));
    expect(built.unbuildable).toEqual([]);
    return built.request.operations.map((operation) => [
      operation.operationType,
      payloadOf(operation).status,
    ]);
  }

  async function acceptAll(): Promise<void> {
    const built = await buildPushRequest(executor, await listQueuedOperations(executor));
    await applyPushResults(
      executor,
      built.sent,
      decodePushResults({
        results: built.request.operations.map((operation) => ({
          operationId: operation.operationId,
          status: 'accepted',
          entityId: operation.entityId,
          appliedServerSequence: '7',
          replayed: false,
        })),
      } as unknown as SyncPushResponse),
      iso(2),
    );
  }

  describe('a new value', () => {
    it('saves its change and queues a create naming it, together', async () => {
      const { id, operationId } = await newValue();

      expect(await getRangeWriteForOperation(executor, operationId)).toMatchObject({
        id,
        status: 'active',
        lowValue: '800',
      });
      expect(await listQueuedOperations(executor)).toEqual([
        expect.objectContaining({
          entityType: 'EffectiveRange',
          entityId: id,
          operationType: 'create',
        }),
      ]);
    });

    it('is pushed as the full §7.6 payload, with the server-assigned link left null', async () => {
      const { id } = await newValue();

      const built = await buildPushRequest(executor, await listQueuedOperations(executor));

      expect(built.request.operations[0]).toMatchObject({
        entityType: 'EffectiveRange',
        operationType: 'create',
      });
      expect(payloadOf(built.request.operations[0])).toEqual({
        id,
        rangeType: 'daily_output_ml',
        lowValue: 800,
        highValue: 1600.5,
        targetValue: null,
        unit: 'mL',
        provenance: 'patient_set',
        status: 'active',
        previousRangeId: null,
      });
    });

    /**
     * §7.6 is built for this pair: the create, then its withdrawal. The first
     * version deleted the unsent create instead, which silently undid the
     * withdrawal whenever the create had in fact reached the server (#147).
     */
    it('is withdrawn by queuing a withdrawal behind it, never by deleting it', async () => {
      const { id } = await newValue();

      await enqueueRangeStatusChange(
        executor,
        { ...STORED_ROW, id, lowValue: 800, highValue: 1600.5, provenance: 'patient_set' },
        'superseded',
        AT(2),
      );

      expect(await pushedStatuses()).toEqual([
        ['create', 'active'],
        ['update', 'superseded'],
      ]);
    });

    /** §9.3: back in the queue after a timeout, it may already have been applied. */
    it('is withdrawn the same way after a push of unknown fate', async () => {
      const { id, operationId } = await newValue();
      await recordAttempt(executor, operationId, iso(2));
      await revertToQueued(executor, operationId);

      await enqueueRangeStatusChange(
        executor,
        { ...STORED_ROW, id, lowValue: 800, highValue: 1600.5, provenance: 'patient_set' },
        'superseded',
        AT(3),
      );

      expect(await pushedStatuses()).toEqual([
        ['create', 'active'],
        ['update', 'superseded'],
      ]);
    });
  });

  describe('a status change to a stored row', () => {
    it("echoes the row's stored content, as §7.6 requires of an update", async () => {
      await enqueueRangeStatusChange(executor, STORED_ROW, 'superseded', AT(1));

      const built = await buildPushRequest(executor, await listQueuedOperations(executor));

      expect(built.request.operations[0]).toMatchObject({
        entityId: STORED_ID,
        operationType: 'update',
      });
      expect(payloadOf(built.request.operations[0])).toEqual({
        id: STORED_ID,
        rangeType: 'daily_output_ml',
        lowValue: 700,
        highValue: null,
        targetValue: null,
        unit: 'mL',
        provenance: 'patient_confirmed_suggestion',
        status: 'superseded',
        previousRangeId: null,
      });
    });

    /**
     * #147's must-fix: with one status per range, both updates went out saying
     * `superseded`, and §7.6 refuses `proposed` → `superseded`. Each operation
     * now carries the status it was queued with.
     */
    it('sends each queued change with its own status: accept a proposal, then withdraw it', async () => {
      await enqueueRangeStatusChange(executor, STORED_ROW, 'active', AT(1));
      await enqueueRangeStatusChange(executor, STORED_ROW, 'superseded', AT(2));

      expect(await pushedStatuses()).toEqual([
        ['update', 'active'],
        ['update', 'superseded'],
      ]);
    });
  });

  describe('what the screen lays over the cached answer', () => {
    it('includes a change while it waits to send, and says so', async () => {
      const { operationId } = await newValue(1);

      expect(await listOverlayRangeWrites(executor)).toEqual([
        expect.objectContaining({ operationId, pending: true }),
      ]);
    });

    /** Between the push that sends it and the refresh that shows it, the change must not flick back. */
    it('keeps a sent change, no longer pending, until a newer cached answer reflects it', async () => {
      const { operationId } = await newValue(1);
      await acceptAll();

      expect(await listOverlayRangeWrites(executor)).toEqual([
        expect.objectContaining({ operationId, pending: false }),
      ]);

      const reflected = await listSettledRangeWriteOperations(executor);
      await replaceRangeCache(executor, [], iso(3), reflected);

      expect(await listOverlayRangeWrites(executor)).toEqual([]);
    });

    /**
     * Decided by WHEN the change was settled relative to the read, never by
     * comparing device-clock timestamps (#147): a change settled after the read
     * began may not be in its answer.
     */
    it('keeps a change settled after the read began, even once that answer is cached', async () => {
      const snapshot = await listSettledRangeWriteOperations(executor); // read begins
      const { operationId } = await newValue(1);
      await acceptAll(); // settled while the read is in flight

      await replaceRangeCache(executor, [], iso(3), snapshot);

      expect(await listOverlayRangeWrites(executor)).toEqual([
        expect.objectContaining({ operationId }),
      ]);
    });

    it('keeps a change still waiting to send through any number of refreshes', async () => {
      const { operationId } = await newValue(1);

      await replaceRangeCache(
        executor,
        [],
        iso(3),
        await listSettledRangeWriteOperations(executor),
      );

      expect(await listOverlayRangeWrites(executor)).toEqual([
        expect.objectContaining({ operationId, pending: true }),
      ]);
    });

    /** A refused change is in the correction inbox; showing it here too would claim a value is in use. */
    it('leaves out a change the server refused', async () => {
      const { operationId } = await newValue(1);
      await markRejected(executor, operationId, {
        reasonCode: 'PAYLOAD_FIELD_INVALID',
        field: 'lowValue',
        rejectedAt: iso(2),
      });

      expect(await listOverlayRangeWrites(executor)).toEqual([]);
    });

    /** #147: the filter was per range, so a new action on a range with a refused one was never shown. */
    it('still shows a later change to a range whose earlier change was refused', async () => {
      const first = await enqueueRangeStatusChange(executor, STORED_ROW, 'superseded', AT(1));
      await markRejected(executor, first.operationId, {
        reasonCode: 'ENTITY_NOT_FOUND',
        field: null,
        rejectedAt: iso(2),
      });
      const second = await enqueueRangeStatusChange(executor, STORED_ROW, 'superseded', AT(3));

      expect((await listOverlayRangeWrites(executor)).map((write) => write.operationId)).toEqual([
        second.operationId,
      ]);
    });

    it('keeps a refused change through a refresh, for the correction inbox to describe', async () => {
      const { operationId } = await newValue(1);
      await markRejected(executor, operationId, {
        reasonCode: 'PAYLOAD_FIELD_INVALID',
        field: 'lowValue',
        rejectedAt: iso(2),
      });

      await replaceRangeCache(
        executor,
        [],
        iso(3),
        await listSettledRangeWriteOperations(executor),
      );

      expect(await getRangeWriteForOperation(executor, operationId)).toBeDefined();
    });

    it('drops a refused change and its operation together when the patient removes it', async () => {
      const { operationId } = await newValue(1);
      await markRejected(executor, operationId, {
        reasonCode: 'PAYLOAD_FIELD_INVALID',
        field: 'lowValue',
        rejectedAt: iso(2),
      });

      await discardRejectedRangeWrite(executor, operationId);

      expect(await executor.getAllAsync('SELECT * FROM sync_queue;')).toEqual([]);
      expect(await getRangeWriteForOperation(executor, operationId)).toBeUndefined();
    });

    it('leaves another change to the same range alone when one is removed', async () => {
      const first = await enqueueRangeStatusChange(executor, STORED_ROW, 'superseded', AT(1));
      await markRejected(executor, first.operationId, {
        reasonCode: 'ENTITY_NOT_FOUND',
        field: null,
        rejectedAt: iso(2),
      });
      const second = await enqueueRangeStatusChange(executor, STORED_ROW, 'superseded', AT(3));

      await discardRejectedRangeWrite(executor, first.operationId);

      expect(await getRangeWriteForOperation(executor, second.operationId)).toBeDefined();
      expect(await pushedStatuses()).toEqual([['update', 'superseded']]);
    });
  });

  describe('the cached answer', () => {
    it('round-trips what the read sent, in the sync spelling', async () => {
      const decoded = decodeRanges([READ_RESPONSE_RANGE]);
      if (decoded === undefined) throw new Error('did not decode');
      await replaceRangeCache(executor, decoded, iso(4), []);

      const cache = await readRangeCache(executor);

      expect(cache?.fetchedAt).toBe(iso(4));
      expect(cache?.ranges[0]).toMatchObject({
        provenance: 'patient_set',
        patientRange: { id: STORED_ID, provenance: 'patient_set' },
        basis: { lowValue: 600 },
      });
    });

    it('is absent before the first fetch, rather than an empty list', async () => {
      expect(await readRangeCache(executor)).toBeUndefined();
    });

    /** A server from before P4.S3 slice 4 still yields a usable, read-only answer. */
    it('reads the fields slice 4 added as null when a server does not send them', () => {
      const {
        patientRange: _patientRange,
        proposal: _proposal,
        limits: _limits,
        ...older
      } = READ_RESPONSE_RANGE;
      const { lowValue: _low, highValue: _high, ...olderBasis } = READ_RESPONSE_RANGE.basis;

      expect(decodeRanges([{ ...older, basis: olderBasis }])?.[0]).toMatchObject({
        patientRange: null,
        proposal: null,
        limits: null,
        basis: { lowValue: null, highValue: null },
      });
    });

    /** All or nothing: a partial list would silently drop a range the patient has. */
    it.each([
      ['a bound that is not a number', { lowValue: '700' }],
      ['an unknown provenance', { provenance: 'SOMEONE_ELSE' }],
      [
        'a patient row with a physician provenance',
        { patientRange: { ...READ_RESPONSE_RANGE.patientRange, provenance: 'PHYSICIAN_SET' } },
      ],
      ['an absent threshold flag', { isActiveThreshold: undefined }],
    ])('refuses the whole answer for %s', (_name, change) => {
      expect(
        decodeRanges([READ_RESPONSE_RANGE, { ...READ_RESPONSE_RANGE, ...change }]),
      ).toBeUndefined();
    });
  });

  describe('the delta pull', () => {
    /** Recognised and counted, not stored: the screen reads the resolved answer instead. */
    it('counts a range change apart from types this build does not know, and still advances', async () => {
      const page = {
        changes: [
          {
            entityType: 'EffectiveRange',
            entityId: STORED_ID,
            serverSequence: '12',
            deleted: false,
            clientUpdatedAt: iso(1),
            payload: { id: STORED_ID },
          },
          {
            entityType: 'SomethingNew',
            entityId: STORED_ID,
            serverSequence: '13',
            deleted: false,
            clientUpdatedAt: iso(1),
            payload: {},
          },
        ],
        cursor: '13',
        hasMore: false,
      } as unknown as SyncDeltaResponse;

      const outcome = await applyDeltaPage(executor, decodeDeltaPage(page), iso(2));

      expect(outcome.rangeChanges).toBe(1);
      expect(outcome.unsupportedEntity).toBe(1);
      expect(await getCursor(executor)).toBe('13');
    });
  });
});
