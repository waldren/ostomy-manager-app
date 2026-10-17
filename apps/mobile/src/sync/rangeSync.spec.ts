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
 * screen lays the unsent changes over.
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
  cancelUnsentRangeCreate,
  discardRejectedRangeWrite,
  enqueueRangeCreate,
  enqueueRangeStatusChange,
} from '../db/offlineWrites';
import {
  decodeRanges,
  getRangeWrite,
  listUnreflectedRangeWrites,
  readRangeCache,
  writeRangeCache,
} from '../db/repositories/rangesRepository';
import { getCursor } from '../db/repositories/syncCursorRepository';
import {
  listQueuedOperations,
  markRejected,
  recordAttempt,
} from '../db/repositories/syncQueueRepository';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { applyDeltaPage } from './deltaPull';
import { applyPushResults, buildPushRequest } from './pushOperations';
import { decodeDeltaPage, decodePushResults } from './responseDecoding';

const AT = (minute: number) => () => new Date(Date.UTC(2026, 9, 17, 12, minute));
const iso = (minute: number) => AT(minute)().toISOString();
const STORED_ID = '44444444-4444-4444-8444-444444444444';

/** A delete carries no payload (§3.1), so the type makes reading one explicit. */
function payloadOf(operation: unknown): unknown {
  return (operation as { payload?: unknown } | undefined)?.payload;
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

  async function accept(entityId: string): Promise<void> {
    const built = await buildPushRequest(executor, await listQueuedOperations(executor));
    await applyPushResults(
      executor,
      built.sent,
      decodePushResults({
        results: built.request.operations.map((operation) => ({
          operationId: operation.operationId,
          status: 'accepted',
          entityId,
          appliedServerSequence: '7',
          replayed: false,
        })),
      } as unknown as SyncPushResponse),
      iso(2),
    );
  }

  describe('a new value', () => {
    it('saves the row and queues a create naming it, together', async () => {
      const { id } = await newValue();

      expect(await getRangeWrite(executor, id)).toMatchObject({
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

      expect(built.unbuildable).toEqual([]);
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

    it('is taken back outright when withdrawn before it is sent', async () => {
      const { id } = await newValue();

      expect(await cancelUnsentRangeCreate(executor, id)).toBe(true);

      expect(await listQueuedOperations(executor)).toEqual([]);
      expect(await getRangeWrite(executor, id)).toBeUndefined();
    });

    /**
     * The row holds the LATEST status, so a create built from it after a
     * withdrawal would say `superseded`, and §7.6 refuses a create in any status
     * but `active`. Reachable whenever the create is in flight when the patient
     * withdraws it.
     */
    it('still says active on its create when withdrawn while being sent', async () => {
      const { id, operationId } = await newValue();
      await recordAttempt(executor, operationId, iso(2));

      expect(await cancelUnsentRangeCreate(executor, id)).toBe(false);
      await enqueueRangeStatusChange(
        executor,
        { ...STORED_ROW, id, lowValue: 800, highValue: 1600.5, provenance: 'patient_set' },
        'superseded',
        AT(3),
      );

      // As a retry after an unknown fate would find them (§9.3).
      await executor.runAsync("UPDATE sync_queue SET status = 'queued';");
      const built = await buildPushRequest(executor, await listQueuedOperations(executor));
      expect(
        built.request.operations.map((operation) => [
          operation.operationType,
          (payloadOf(operation) as { status: string }).status,
        ]),
      ).toEqual([
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
  });

  describe('what the screen lays over the cached answer', () => {
    it('includes a change while it waits to send, even if the cache is newer', async () => {
      const { id } = await newValue(1);
      await writeRangeCache(executor, [], iso(5));

      const unreflected = await listUnreflectedRangeWrites(executor, iso(5));

      expect(unreflected.map((write) => write.id)).toEqual([id]);
    });

    /** Between the push that sends it and the refresh that shows it, the change must not flick back. */
    it('keeps a sent change until a newer cached answer arrives', async () => {
      const { id } = await newValue(1);
      await accept(id);
      expect(await listQueuedOperations(executor)).toEqual([]);

      expect(await listUnreflectedRangeWrites(executor, iso(0))).toHaveLength(1);
      expect(await listUnreflectedRangeWrites(executor, iso(3))).toEqual([]);
    });

    /** A refused change is in the correction inbox; showing it here too would claim a value is in use. */
    it('never includes a change the server refused', async () => {
      const { operationId } = await newValue(1);
      await markRejected(executor, operationId, {
        reasonCode: 'PAYLOAD_FIELD_INVALID',
        field: 'lowValue',
        rejectedAt: iso(2),
      });

      expect(await listUnreflectedRangeWrites(executor, undefined)).toEqual([]);
    });

    it('drops a refused change and its row together when the patient removes it', async () => {
      const { id, operationId } = await newValue(1);
      await markRejected(executor, operationId, {
        reasonCode: 'PAYLOAD_FIELD_INVALID',
        field: 'lowValue',
        rejectedAt: iso(2),
      });

      await discardRejectedRangeWrite(executor, { rejectedOperationId: operationId, entityId: id });

      expect(await executor.getAllAsync('SELECT * FROM sync_queue;')).toEqual([]);
      expect(await getRangeWrite(executor, id)).toBeUndefined();
    });

    it('keeps the row while another change to it waits, because that change is built from it', async () => {
      const first = await enqueueRangeStatusChange(executor, STORED_ROW, 'superseded', AT(1));
      await markRejected(executor, first.operationId, {
        reasonCode: 'ENTITY_NOT_FOUND',
        field: null,
        rejectedAt: iso(2),
      });
      await enqueueRangeStatusChange(executor, STORED_ROW, 'superseded', AT(3));

      await discardRejectedRangeWrite(executor, {
        rejectedOperationId: first.operationId,
        entityId: STORED_ID,
      });

      expect(await getRangeWrite(executor, STORED_ID)).toBeDefined();
      expect(await listQueuedOperations(executor)).toHaveLength(1);
    });
  });

  describe('the cached answer', () => {
    it('round-trips what the read sent, in the sync spelling', async () => {
      const decoded = decodeRanges([READ_RESPONSE_RANGE]);
      if (decoded === undefined) throw new Error('did not decode');
      await writeRangeCache(executor, decoded, iso(4));

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
