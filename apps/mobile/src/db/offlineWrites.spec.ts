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
  enqueueObservationDelete,
  enqueueObservationUpdate,
  enqueueVolumelessUrineCreate,
  enqueueVolumetricObservationCreate,
  enqueueWeightOrHeartRateObservationCreate,
} from './offlineWrites';
import { getObservationById } from './repositories/observationsRepository';
import { listQueuedOperations } from './repositories/syncQueueRepository';
import { toObservationPayload } from '../sync/pushOperations';
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
        // ADR-0018 (amended): a measured entry carries the explicit
        // |Measured| qualifier, not NULL. NULL now means only "this
        // observation has no toggle" — weight, resting heart rate.
        method: '258104002',
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

      // Built from the STORED ROW by the SYNC WORKER'S OWN builder.
      //
      // This used to read `queued[0].payload` — a wire object frozen into
      // the queue at enqueue time. That froze the contract too: an
      // amendment to docs/sync-contract.md could never reach an operation
      // already queued.
      //
      // Its replacement was a second builder living next to the enqueue
      // functions, which drifted the moment §7.2 made `valueQuantity`
      // conditional: this assertion stayed green while the code that
      // actually pushes changed underneath it. `toObservationPayload` is
      // the one the worker calls, so a contract change that breaks the push
      // path now breaks this test too.
      const stored = await getObservationById(executor, id);
      const payload = toObservationPayload(stored!);
      expect(payload).toEqual({
        resourceType: 'Observation',
        id,
        status: 'final',
        code: '79560-9',
        valueQuantity: { value: 350, unit: 'mL' },
        effectiveDateTime: '2026-09-11T14:00:00.000Z',
        method: '258104002',
        enteredMeasurementSystem: 'metric',
        // Captured from the device at entry, not passed in by the caller
        // (ADR-0016).
        enteredTimezone: expect.any(String),
        // P3.S1: always present, null when there is none — an absent key and a
        // null one read the same to a human and differently to a client.
        fluidTypeCode: null,
      });
    });

    /**
     * AC 12.1 AC2 — a voided-urine entry recording a COLOUR and no amount.
     *
     * The case the feature exists for: a patient who cannot measure still
     * produces a hydration signal, and that population is the one whose
     * hydration matters most.
     */
    it('creates a colour-only voided-urine observation with no volume at all', async () => {
      const { id, operationId } = await enqueueVolumelessUrineCreate(
        executor,
        {
          code: '9187-6',
          effectiveDatetime: '2026-09-23T09:30:00.000Z',
          enteredMeasurementSystem: 'metric',
          urineColorCode: 'amber',
        },
        FIXED_NOW,
      );

      const observation = await getObservationById(executor, id);
      expect(observation).toMatchObject({
        id,
        code: '9187-6',
        urineColorCode: 'amber',
        // NULL, not '0' and not ''. A missing amount is not a void of zero,
        // and the two disagree in every daily total forever afterwards.
        valueQuantityValue: null,
        // The pair travels together — `observations_volume_with_unit`.
        valueQuantityUnit: null,
        // ADR-0018 (amended): with no number, there is nothing for
        // Measured/Estimated to describe, and NULL is what says so.
        method: null,
      });

      // ADR-0012 still applies with no volume to express: it is the client's
      // assertion about the entry, not a property of the number.
      expect(observation?.enteredMeasurementSystem).toBe('metric');

      const queued = await listQueuedOperations(executor);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ operationId, entityId: id, operationType: 'create' });
    });

    /**
     * §7.2: `valueQuantity` is **omitted** on a colour-only urine entry, never
     * sent as `null` and never as `{ value: 0 }`.
     *
     * This is the assertion that would have caught the bug this write path
     * shipped with: `Number(null)` is `0`, so a payload builder that named the
     * field unconditionally sent a fabricated zero-volume reading that the
     * server accepts and every daily total then believes.
     */
    it('omits valueQuantity from the wire payload of a colour-only urine entry', async () => {
      const { id } = await enqueueVolumelessUrineCreate(
        executor,
        {
          code: '9187-6',
          effectiveDatetime: '2026-09-23T09:30:00.000Z',
          enteredMeasurementSystem: 'metric',
          urineColorCode: 'pale_straw',
        },
        FIXED_NOW,
      );

      const stored = await getObservationById(executor, id);
      const payload = toObservationPayload(stored!);

      expect('valueQuantity' in payload).toBe(false);
      expect(payload).toMatchObject({
        resourceType: 'Observation',
        code: '9187-6',
        urineColorCode: 'pale_straw',
        method: null,
      });
    });

    /** A urine entry may carry BOTH, and then nothing is omitted. */
    it('keeps both the volume and the colour on a measured urine entry', async () => {
      const { id } = await enqueueVolumetricObservationCreate(
        executor,
        {
          code: '9187-6',
          valueQuantityValue: '275.0000',
          valueQuantityUnit: 'mL',
          effectiveDatetime: '2026-09-23T09:30:00.000Z',
          measuredOrEstimated: 'measured',
          enteredMeasurementSystem: 'metric',
          urineColorCode: 'straw',
        },
        FIXED_NOW,
      );

      const stored = await getObservationById(executor, id);
      expect(toObservationPayload(stored!)).toMatchObject({
        valueQuantity: { value: 275, unit: 'mL' },
        urineColorCode: 'straw',
        method: '258104002',
      });
    });

    /**
     * The colour is absent from the payload rather than `null` when there is
     * none: §7.2 defines `urineColorCode` as plain optional, unlike
     * `fluidTypeCode`, which it defines as always-present-possibly-null.
     */
    it('omits urineColorCode entirely on an entry that has no colour', async () => {
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

      const stored = await getObservationById(executor, id);
      expect('urineColorCode' in toObservationPayload(stored!)).toBe(false);
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

    /**
     * The other half. Both answers are now explicit codes (ADR-0018,
     * amended), so the two are distinguishable from each other AND from an
     * observation the toggle never applied to.
     */
    it('stores the explicit |Measured| code for a Measured entry', async () => {
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

      expect((await getObservationById(executor, id))?.method).toBe('258104002');
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
