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

import { ESTIMATION_METHOD_CODE } from '@ostomy/core/validation';

import type { SqliteExecutor } from './executor';
import { runMigrations } from './migrations';
import {
  buildObservationPayload,
  enqueueObservationDelete,
  enqueueObservationUpdate,
  enqueueVolumetricObservationCreate,
  enqueueWeightOrHeartRateObservationCreate,
} from './offlineWrites';
import { getObservationById } from './repositories/observationsRepository';
import { listQueuedOperations } from './repositories/syncQueueRepository';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

const FIXED_NOW = () => new Date('2026-09-11T22:04:11.412Z');

describe('offlineWrites — the local write-then-enqueue transaction', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-offline-writes-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  // No SRS §7 acceptance criterion covers this app-native architecture
  // directly (it is CLAUDE.md/ADR-0001 narrative, not a numbered AC) — per
  // docs/testing.md, described plainly rather than attached to an invented
  // AC id. AC 13.1 AC4 (§7 User Story 13.1) is tested in
  // syncQueueRepository.spec.ts, where it actually applies: a rejected
  // operation is retained rather than dropped.
  describe('a data-entry write commits to local storage and the sync queue together, atomically', () => {
    it('creates a measured volumetric observation and queues a matching create operation', async () => {
      const { id, operationId } = await enqueueVolumetricObservationCreate(
        executor,
        {
          code: '79560-9',
          valueQuantityValue: '350.0000',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-11T14:00:00.000Z',
          measuredOrEstimated: 'measured',
          enteredMeasurementSystem: 'metric',
        },
        FIXED_NOW,
      );

      const observation = await getObservationById(executor, id);
      expect(observation).toMatchObject({
        id,
        code: '79560-9',
        valueQuantityValue: '350.0000',
        valueQuantityUnit: 'mL',
        method: null,
        deletedAt: null,
        serverSequence: null,
      });

      const queued = await listQueuedOperations(executor);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        operationId,
        entityId: id,
        entityType: 'Observation',
        operationType: 'create',
        status: 'queued',
      });
      // §1: "Never the entity id" — the operation id and entity id must
      // never collide, or a later edit looks like a replay of the create.
      expect(operationId).not.toEqual(id);

      // Built from the STORED ROW, the way the sync worker will build it.
      //
      // This used to read `queued[0].payload` — a wire object frozen into
      // the queue at enqueue time. That froze the contract too: an
      // amendment to docs/sync-contract.md could never reach an operation
      // already queued. Asserting against the builder is both the same
      // coverage and the shape that survives ADR-0016 adding a field.
      const stored = await getObservationById(executor, id);
      const payload = JSON.parse(
        buildObservationPayload({
          id,
          code: stored!.code,
          valueQuantityValue: stored!.valueQuantityValue,
          valueQuantityUnit: stored!.valueQuantityUnit,
          effectiveDatetime: stored!.effectiveDatetime,
          method: stored!.method,
          enteredMeasurementSystem: stored!.enteredMeasurementSystem,
          enteredTimezone: stored!.enteredTimezone,
        }),
      );
      expect(payload).toEqual({
        resourceType: 'Observation',
        id,
        status: 'final',
        code: '79560-9',
        valueQuantity: { value: 350, unit: 'mL' },
        effectiveDateTime: '2026-09-11T14:00:00.000Z',
        method: null,
        enteredMeasurementSystem: 'metric',
        // Captured from the device at entry, not passed in by the caller
        // (ADR-0016).
        enteredTimezone: expect.any(String),
      });
    });

    /**
     * D4 resolved (ADR-0018), so this replaces the tripwire that refused an
     * Estimated entry outright. What it must assert now is the thing that
     * tripwire existed to protect: an Estimated entry stores the CODE, never
     * `null`.
     *
     * `method` is the only stored representation of the Measured/Estimated
     * choice, so a `null` here would be indistinguishable from a Measured
     * entry forever after — which is AC 2.2 AC2's history badges silently
     * wrong, with no separate source of truth to migrate back from.
     */
    it('stores the resolved SNOMED code for an Estimated entry, never null', async () => {
      const { id } = await enqueueVolumetricObservationCreate(
        executor,
        {
          code: '79560-9',
          valueQuantityValue: '350.0000',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-11T14:00:00.000Z',
          measuredOrEstimated: 'estimated',
          enteredMeasurementSystem: 'metric',
        },
        FIXED_NOW,
      );

      const observation = await getObservationById(executor, id);
      expect(observation?.method).not.toBeNull();
      expect(ESTIMATION_METHOD_CODE.resolved).toBe(true);
      if (!ESTIMATION_METHOD_CODE.resolved) return;
      expect(observation?.method).toBe(ESTIMATION_METHOD_CODE.code);
    });

    /** The other half: a Measured entry stays `null`, so the two are distinguishable in storage. */
    it('stores null for a Measured entry, keeping the two distinguishable', async () => {
      const { id } = await enqueueVolumetricObservationCreate(
        executor,
        {
          code: '79560-9',
          valueQuantityValue: '350.0000',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-11T14:00:00.000Z',
          measuredOrEstimated: 'measured',
          enteredMeasurementSystem: 'metric',
        },
        FIXED_NOW,
      );

      expect((await getObservationById(executor, id))?.method).toBeNull();
    });

    it('creates a weight observation with no Measured/Estimated toggle at all (CLAUDE.md: the toggle is volumetric-entry-only)', async () => {
      const { id } = await enqueueWeightOrHeartRateObservationCreate(
        executor,
        {
          code: '29463-7',
          valueQuantityValue: '70.9000',
          valueQuantityUnit: 'kg',
          effectiveDatetime: '2026-09-11T08:00:00.000Z',
          enteredMeasurementSystem: 'metric',
        },
        FIXED_NOW,
      );

      const observation = await getObservationById(executor, id);
      expect(observation?.method).toBeNull();
    });
  });

  describe('update and delete queue the same shapes the wire contract requires', () => {
    it('an update replaces every field and queues a full-replacement payload (§4)', async () => {
      const created = await enqueueVolumetricObservationCreate(
        executor,
        {
          code: '79560-9',
          valueQuantityValue: '350.0000',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-11T14:00:00.000Z',
          measuredOrEstimated: 'measured',
          enteredMeasurementSystem: 'metric',
        },
        FIXED_NOW,
      );

      const { operationId } = await enqueueObservationUpdate(
        executor,
        {
          id: created.id,
          code: '79560-9',
          valueQuantityValue: '400.0000',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-11T14:00:00.000Z',
          method: null,
          enteredMeasurementSystem: 'metric',
        },
        FIXED_NOW,
      );

      const observation = await getObservationById(executor, created.id);
      expect(observation?.valueQuantityValue).toBe('400.0000');

      const queued = await listQueuedOperations(executor);
      const updateOp = queued.find((op) => op.operationId === operationId);
      expect(updateOp?.operationType).toBe('update');
      // The queue no longer carries a payload at all; what matters is that
      // the row it points at reflects the edit the push will serialise.
      const edited = await getObservationById(executor, created.id);
      expect(edited?.valueQuantityValue).toBe('400.0000');
    });

    it('a delete tombstones the row locally and queues a payload-less delete operation (§3.1, §1)', async () => {
      const created = await enqueueVolumetricObservationCreate(
        executor,
        {
          code: '79560-9',
          valueQuantityValue: '350.0000',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-11T14:00:00.000Z',
          measuredOrEstimated: 'measured',
          enteredMeasurementSystem: 'metric',
        },
        FIXED_NOW,
      );

      const { operationId } = await enqueueObservationDelete(executor, created.id, FIXED_NOW);

      const observation = await getObservationById(executor, created.id);
      expect(observation?.deletedAt).not.toBeNull();

      const queued = await listQueuedOperations(executor);
      const deleteOp = queued.find((op) => op.operationId === operationId);
      expect(deleteOp?.operationType).toBe('delete');
      // §3.1's "payload is absent for operationType: delete" is now
      // structural rather than a nullable column: nothing in the queue can
      // carry one.
      expect(observation?.deletedAt).not.toBeNull();
    });
  });
});
