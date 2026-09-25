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

import type { SyncDeltaResponse } from '@ostomy/core/api-client';

import type { SqliteExecutor } from '../db/executor';
import { enqueueObservationDelete, enqueueVolumetricObservationCreate } from '../db/offlineWrites';
import { getObservationById } from '../db/repositories/observationsRepository';
import { getCursor } from '../db/repositories/syncCursorRepository';
import { runMigrations } from '../db/migrations';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { applyDeltaPage } from './deltaPull';
import { decodeDeltaPage } from './responseDecoding';

/** Every fixture goes through the real decoder, so these tests exercise the boundary rather than bypassing it. */
function page(raw: SyncDeltaResponse) {
  return decodeDeltaPage(raw);
}

const STOMA_OUTPUT_CODE = '79560-9';
const FIXED_NOW = () => new Date('2026-09-15T12:00:00.000Z');
const APPLIED_AT = '2026-09-15T12:00:00.000Z';

function upsertPage(options: {
  entityId: string;
  serverSequence: string;
  clientUpdatedAt: string;
  value: number;
  cursor: string;
  effectiveDateTime?: string;
  enteredTimezone?: string;
  code?: string;
  fluidTypeCode?: string | null;
  urineColorCode?: string;
}): SyncDeltaResponse {
  return {
    changes: [
      {
        entityType: 'Observation',
        entityId: options.entityId,
        serverSequence: options.serverSequence,
        deleted: false,
        clientUpdatedAt: options.clientUpdatedAt,
        payload: {
          resourceType: 'Observation',
          id: options.entityId,
          status: 'final',
          code: options.code ?? STOMA_OUTPUT_CODE,
          valueQuantity: { value: options.value, unit: 'mL' },
          effectiveDateTime: options.effectiveDateTime ?? '2026-09-15T11:00:00.000Z',
          method: null,
          enteredMeasurementSystem: 'metric',
          enteredTimezone: options.enteredTimezone ?? 'America/Chicago',
          // §7.2: always present and possibly null. `urineColorCode` is plain
          // optional and omitted when absent, which is why it is spread.
          fluidTypeCode: options.fluidTypeCode ?? null,
          ...(options.urineColorCode === undefined
            ? {}
            : { urineColorCode: options.urineColorCode }),
        },
      },
    ],
    cursor: options.cursor,
    hasMore: false,
  } as unknown as SyncDeltaResponse;
}

function tombstonePage(options: {
  entityId: string;
  serverSequence: string;
  clientUpdatedAt: string;
  cursor: string;
}): SyncDeltaResponse {
  return {
    changes: [
      {
        entityType: 'Observation',
        entityId: options.entityId,
        serverSequence: options.serverSequence,
        deleted: true,
        clientUpdatedAt: options.clientUpdatedAt,
      },
    ],
    cursor: options.cursor,
    hasMore: false,
  } as unknown as SyncDeltaResponse;
}

describe('applyDeltaPage', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-delta-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  it('inserts a row this device has never seen', async () => {
    const raw = upsertPage({
      entityId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      serverSequence: '100',
      clientUpdatedAt: '2026-09-15T11:00:00.000Z',
      value: 350,
      cursor: '100',
    });

    const outcome = await applyDeltaPage(executor, page(raw), APPLIED_AT);

    expect(outcome.upserts).toBe(1);
    const stored = await getObservationById(executor, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(stored?.valueQuantityValue).toBe('350');
    expect(stored?.serverSequence).toBe('100');
  });

  /**
   * The coded fields, written to the local row.
   *
   * §7.2 emits them and this module has to store them, and **this was the one
   * of the six observation field-lists with no test at all** — which is why
   * `fluid_type_code` was missing from both statements here from P3.S1 until
   * P3.S2's review found it. A device rebuilding its store from a delta (a
   * fresh install, or the ADR-0014 wipe when a different subject signs in)
   * dropped the fluid categorisation off every intake entry it pulled, and
   * irrecoverably for that device short of another rebuild.
   *
   * The server side is covered by `sync.integration.spec.ts`'s "the coded
   * fields survive a delta pull"; this is the other half, and neither proves
   * anything about the other.
   */
  describe('§7.2 coded fields reach the local row', () => {
    it('writes both on an insert', async () => {
      const raw = upsertPage({
        entityId: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        serverSequence: '210',
        clientUpdatedAt: '2026-09-15T11:00:00.000Z',
        value: 275,
        cursor: '210',
        code: '9187-6',
        urineColorCode: 'amber',
      });

      await applyDeltaPage(executor, page(raw), APPLIED_AT);

      const stored = await getObservationById(executor, 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      expect(stored?.urineColorCode).toBe('amber');
    });

    it('writes the fluid categorisation on an insert', async () => {
      const raw = upsertPage({
        entityId: 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        serverSequence: '220',
        clientUpdatedAt: '2026-09-15T11:00:00.000Z',
        value: 250,
        cursor: '220',
        code: '9000-1',
        fluidTypeCode: 'water',
      });

      await applyDeltaPage(executor, page(raw), APPLIED_AT);

      const stored = await getObservationById(executor, 'dddddddd-bbbb-4ccc-8ddd-eeeeeeeeeeee');
      expect(stored?.fluidTypeCode).toBe('water');
    });

    /**
     * The UPDATE statement is the separate risk: a §4 update is a full
     * replacement, so a column left out of the SET list keeps its old value
     * while everything around it is replaced — a row blended from two versions,
     * which is worse than one that never had the value.
     */
    it('replaces both on an update, rather than leaving the old values', async () => {
      const entityId = 'eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      await applyDeltaPage(
        executor,
        page(
          upsertPage({
            entityId,
            serverSequence: '230',
            clientUpdatedAt: '2026-09-15T11:00:00.000Z',
            value: 100,
            cursor: '230',
            code: '9187-6',
            fluidTypeCode: 'water',
            urineColorCode: 'straw',
          }),
        ),
        APPLIED_AT,
      );

      await applyDeltaPage(
        executor,
        page(
          upsertPage({
            entityId,
            serverSequence: '231',
            clientUpdatedAt: '2026-09-15T11:30:00.000Z',
            value: 100,
            cursor: '231',
            code: '9187-6',
            fluidTypeCode: null,
            urineColorCode: 'brown',
          }),
        ),
        APPLIED_AT,
      );

      const stored = await getObservationById(executor, entityId);
      expect(stored?.urineColorCode).toBe('brown');
      // Cleared, not retained. `null` in the payload is a value, not an
      // omission.
      expect(stored?.fluidTypeCode).toBeNull();
    });
  });

  /**
   * ADR-0016: `localDate` is absent from the wire on purpose and derived on
   * both sides from the same shared helper. A device that derived it
   * differently would show one daily total on the phone and another on the
   * web, with nothing detecting the disagreement.
   */
  it('derives localDate locally from the payload instant and zone', async () => {
    // 02:30 UTC on the 16th is still the 15th in Chicago (UTC-5 in September).
    const raw = upsertPage({
      entityId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      serverSequence: '100',
      clientUpdatedAt: '2026-09-16T02:30:00.000Z',
      value: 350,
      cursor: '100',
      effectiveDateTime: '2026-09-16T02:30:00.000Z',
      enteredTimezone: 'America/Chicago',
    });

    await applyDeltaPage(executor, page(raw), APPLIED_AT);

    const stored = await getObservationById(executor, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(stored?.localDate).toBe('2026-09-15');
  });

  it('advances the cursor to the page cursor after the changes are written', async () => {
    const raw = upsertPage({
      entityId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      serverSequence: '100',
      clientUpdatedAt: '2026-09-15T11:00:00.000Z',
      value: 350,
      cursor: '137',
    });

    await applyDeltaPage(executor, page(raw), APPLIED_AT);

    expect(await getCursor(executor)).toBe('137');
  });

  it('overwrites a local row when the incoming version is newer', async () => {
    const { id } = await enqueueVolumetricObservationCreate(
      executor,
      {
        code: STOMA_OUTPUT_CODE,
        valueQuantityValue: '100',
        valueQuantityUnit: 'mL',
        effectiveDatetime: '2026-09-15T10:00:00.000Z',
        measuredOrEstimated: 'measured',
        enteredMeasurementSystem: 'metric',
      },
      () => new Date('2026-09-15T10:00:00.000Z'),
    );

    await applyDeltaPage(
      executor,
      page(
        upsertPage({
          entityId: id,
          serverSequence: '200',
          clientUpdatedAt: '2026-09-15T11:00:00.000Z',
          value: 425,
          cursor: '200',
        }),
      ),
      APPLIED_AT,
    );

    expect((await getObservationById(executor, id))?.valueQuantityValue).toBe('425');
  });

  /**
   * The failure this guard exists for: the local row is still queued for
   * push, the server's page predates it, and applying it would make an entry
   * the patient was already told was saved (§9.5) change under them — then
   * change back one cycle later when the queued operation lands.
   */
  it('keeps a newer local row rather than applying a stale server version', async () => {
    const { id } = await enqueueVolumetricObservationCreate(
      executor,
      {
        code: STOMA_OUTPUT_CODE,
        valueQuantityValue: '999',
        valueQuantityUnit: 'mL',
        effectiveDatetime: '2026-09-15T11:30:00.000Z',
        measuredOrEstimated: 'measured',
        enteredMeasurementSystem: 'metric',
      },
      () => new Date('2026-09-15T11:30:00.000Z'),
    );

    const outcome = await applyDeltaPage(
      executor,
      page(
        upsertPage({
          entityId: id,
          serverSequence: '200',
          clientUpdatedAt: '2026-09-15T10:00:00.000Z',
          value: 100,
          cursor: '200',
        }),
      ),
      APPLIED_AT,
    );

    expect(outcome.skippedAsStale).toBe(1);
    expect((await getObservationById(executor, id))?.valueQuantityValue).toBe('999');
    // The cursor still advances: the change WAS shown to this device, and
    // it decided against it. Withholding the advance would re-download the
    // same page forever.
    expect(await getCursor(executor)).toBe('200');
  });

  /** §4's table: equal timestamps resolve in favour of the incoming version. Doing the opposite here would make the two sides disagree about a tie. */
  it('applies an incoming version whose timestamp ties with the local one', async () => {
    const at = '2026-09-15T11:00:00.000Z';
    const { id } = await enqueueVolumetricObservationCreate(
      executor,
      {
        code: STOMA_OUTPUT_CODE,
        valueQuantityValue: '100',
        valueQuantityUnit: 'mL',
        effectiveDatetime: at,
        measuredOrEstimated: 'measured',
        enteredMeasurementSystem: 'metric',
      },
      () => new Date(at),
    );

    await applyDeltaPage(
      executor,
      page(
        upsertPage({
          entityId: id,
          serverSequence: '200',
          clientUpdatedAt: at,
          value: 425,
          cursor: '200',
        }),
      ),
      APPLIED_AT,
    );

    expect((await getObservationById(executor, id))?.valueQuantityValue).toBe('425');
  });

  it('tombstones a row without blanking the clinical values it still holds', async () => {
    const { id } = await enqueueVolumetricObservationCreate(
      executor,
      {
        code: STOMA_OUTPUT_CODE,
        valueQuantityValue: '350',
        valueQuantityUnit: 'mL',
        effectiveDatetime: '2026-09-15T10:00:00.000Z',
        measuredOrEstimated: 'measured',
        enteredMeasurementSystem: 'metric',
      },
      () => new Date('2026-09-15T10:00:00.000Z'),
    );

    const outcome = await applyDeltaPage(
      executor,
      page(
        tombstonePage({
          entityId: id,
          serverSequence: '300',
          clientUpdatedAt: '2026-09-15T11:00:00.000Z',
          cursor: '300',
        }),
      ),
      APPLIED_AT,
    );

    expect(outcome.tombstones).toBe(1);
    const stored = await getObservationById(executor, id);
    expect(stored?.deletedAt).not.toBeNull();
    // §5.2 sends no payload with a tombstone, so nothing here could
    // repopulate these columns — clearing them would make a deleted row
    // indistinguishable from one written empty.
    expect(stored?.valueQuantityValue).toBe('350');
  });

  /** §4: "an update at T2 beats a delete at T1, resurrecting the row by clearing deletedAt". */
  it('resurrects a locally tombstoned row when a newer upsert arrives', async () => {
    const { id } = await enqueueVolumetricObservationCreate(
      executor,
      {
        code: STOMA_OUTPUT_CODE,
        valueQuantityValue: '350',
        valueQuantityUnit: 'mL',
        effectiveDatetime: '2026-09-15T09:00:00.000Z',
        measuredOrEstimated: 'measured',
        enteredMeasurementSystem: 'metric',
      },
      () => new Date('2026-09-15T09:00:00.000Z'),
    );
    await enqueueObservationDelete(executor, id, () => new Date('2026-09-15T09:30:00.000Z'));
    expect((await getObservationById(executor, id))?.deletedAt).not.toBeNull();

    await applyDeltaPage(
      executor,
      page(
        upsertPage({
          entityId: id,
          serverSequence: '400',
          clientUpdatedAt: '2026-09-15T11:00:00.000Z',
          value: 500,
          cursor: '400',
        }),
      ),
      APPLIED_AT,
    );

    const stored = await getObservationById(executor, id);
    expect(stored?.deletedAt).toBeNull();
    expect(stored?.valueQuantityValue).toBe('500');
  });

  it('preserves created_at across an update rather than re-inserting the row', async () => {
    const { id } = await enqueueVolumetricObservationCreate(
      executor,
      {
        code: STOMA_OUTPUT_CODE,
        valueQuantityValue: '100',
        valueQuantityUnit: 'mL',
        effectiveDatetime: '2026-09-15T10:00:00.000Z',
        measuredOrEstimated: 'measured',
        enteredMeasurementSystem: 'metric',
      },
      () => new Date('2026-09-15T10:00:00.000Z'),
    );
    const createdAt = (await getObservationById(executor, id))?.createdAt;

    await applyDeltaPage(
      executor,
      page(
        upsertPage({
          entityId: id,
          serverSequence: '200',
          clientUpdatedAt: '2026-09-15T11:00:00.000Z',
          value: 425,
          cursor: '200',
        }),
      ),
      APPLIED_AT,
    );

    expect((await getObservationById(executor, id))?.createdAt).toBe(createdAt);
  });
});
