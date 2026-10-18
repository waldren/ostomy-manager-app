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
 * Quick-Add decisions on this device, through sync (P4.S3 slice 5b,
 * `docs/sync-contract.md` §7.7): a decision saved with its operation, pushed
 * under the id the server derives too, and a decision from another device
 * applied by the pull.
 *
 * Against a real SQLite database through the real migrations.
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncDeltaResponse, SyncPushResponse } from '@ostomy/core/api-client';
import { quickAddPreferenceId, type QuickAddRoutine } from '@ostomy/core/sync';

import type { SqliteExecutor } from '../db/executor';
import { runMigrations } from '../db/migrations';
import {
  discardRejectedQuickAddDecision,
  enqueueQuickAddDecision,
  enqueueVolumelessUrineCreate,
  enqueueVolumetricObservationCreate,
  retryRejectedQuickAddDecision,
} from '../db/offlineWrites';
import { listQuickAddCandidates } from '../db/repositories/quickAddRepository';
import { buildQuickAddWidgets, QUICK_ADD_CODES } from '../quickadd/quickAddSuggestions';
import {
  getQuickAddDecision,
  listQuickAddDecisions,
} from '../db/repositories/quickAddDecisionsRepository';
import { getCursor, setCursor } from '../db/repositories/syncCursorRepository';
import { listQueuedOperations, markRejected } from '../db/repositories/syncQueueRepository';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { applyDeltaPage } from './deltaPull';
import { applyPushResults, buildPushRequest } from './pushOperations';
import { decodeDeltaPage, decodePushResults } from './responseDecoding';

const AT = (minute: number) => () => new Date(Date.UTC(2026, 9, 17, 12, minute));
const iso = (minute: number) => AT(minute)().toISOString();
const PROFILE_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

const ROUTINE: QuickAddRoutine = {
  code: '79560-9',
  valueMl: 350.5,
  method: '258104002',
  fluidTypeCode: null,
  urineColorCode: null,
  enteredMeasurementSystem: 'metric',
};

/** The id as the SERVER derives it: the same core function, over Node's SHA-1. */
const serverId = (routine: QuickAddRoutine = ROUTINE) =>
  quickAddPreferenceId(
    PROFILE_ID,
    routine,
    (input) => new Uint8Array(createHash('sha1').update(input).digest()),
  );

function payloadOf(operation: unknown): Record<string, unknown> {
  return (operation as { payload: Record<string, unknown> }).payload;
}

function decisionPage(options: {
  id: string;
  clientUpdatedAt: string;
  decision?: string;
  deleted?: boolean;
  payload?: Record<string, unknown>;
}): SyncDeltaResponse {
  return {
    changes: [
      {
        entityType: 'QuickAddPreference',
        entityId: options.id,
        serverSequence: '21',
        deleted: options.deleted ?? false,
        clientUpdatedAt: options.clientUpdatedAt,
        ...(options.deleted === true
          ? {}
          : {
              payload: options.payload ?? {
                id: options.id,
                ...ROUTINE,
                decision: options.decision ?? 'hidden',
              },
            }),
      },
    ],
    cursor: '21',
    hasMore: false,
  } as unknown as SyncDeltaResponse;
}

describe('Quick-Add decisions on this device, through sync (P4.S3 slice 5b, §7.7)', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-quick-add-sync-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, AT(0));
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  function decide(decision: 'pinned' | 'hidden' | 'none', minute = 1) {
    return enqueueQuickAddDecision(
      executor,
      { profileServerId: PROFILE_ID, routine: ROUTINE, decision },
      AT(minute),
    );
  }

  describe('a decision made here', () => {
    /** The whole point of the derived id: this phone and the server name the same row. */
    it('is saved under the id the server derives for the same routine', async () => {
      const { id } = await decide('pinned');

      expect(id).toBe(await serverId());
      expect(await getQuickAddDecision(executor, id)).toMatchObject({
        routine: ROUTINE,
        decision: 'pinned',
        clientUpdatedAt: iso(1),
      });
    });

    /** A phone cannot know whether another device made the row first; §7.7 compares a create like any write. */
    it('is queued as a create, whoever made the row first', async () => {
      await decide('pinned');
      await decide('hidden', 2);

      expect((await listQueuedOperations(executor)).map((op) => op.operationType)).toEqual([
        'create',
        'create',
      ]);
    });

    it('is pushed as the §7.7 payload, field by field', async () => {
      const { id } = await decide('hidden');

      const built = await buildPushRequest(executor, await listQueuedOperations(executor));

      expect(built.unbuildable).toEqual([]);
      expect(built.request.operations[0]).toMatchObject({
        entityType: 'QuickAddPreference',
        entityId: id,
        operationType: 'create',
      });
      expect(payloadOf(built.request.operations[0])).toEqual({
        id,
        ...ROUTINE,
        decision: 'hidden',
      });
    });

    it('names a colour-only urine routine with no volume and no toggle', async () => {
      const urine: QuickAddRoutine = {
        code: '9187-6',
        valueMl: null,
        method: null,
        fluidTypeCode: null,
        urineColorCode: 'pale_yellow',
        enteredMeasurementSystem: 'metric',
      };
      const { id } = await enqueueQuickAddDecision(
        executor,
        { profileServerId: PROFILE_ID, routine: urine, decision: 'pinned' },
        AT(1),
      );

      const built = await buildPushRequest(executor, await listQueuedOperations(executor));

      expect(id).toBe(await serverId(urine));
      expect(payloadOf(built.request.operations[0])).toMatchObject({ valueMl: null, method: null });
    });
  });

  describe('a decision from another device', () => {
    it('is applied by the pull', async () => {
      const id = await serverId();

      const outcome = await applyDeltaPage(
        executor,
        decodeDeltaPage(decisionPage({ id, clientUpdatedAt: iso(5), decision: 'hidden' })),
        iso(6),
      );

      expect(outcome.quickAddUpserts).toBe(1);
      expect(await getQuickAddDecision(executor, id)).toMatchObject({ decision: 'hidden' });
    });

    /** §9.5: the patient's own unsent decision keeps showing until the server has chosen. */
    it('does not replace a newer decision made here', async () => {
      const { id } = await decide('pinned', 10);

      const outcome = await applyDeltaPage(
        executor,
        decodeDeltaPage(decisionPage({ id, clientUpdatedAt: iso(5), decision: 'hidden' })),
        iso(11),
      );

      expect(outcome.skippedAsStale).toBe(1);
      expect(await getQuickAddDecision(executor, id)).toMatchObject({ decision: 'pinned' });
    });

    it('replaces an older one', async () => {
      const { id } = await decide('pinned', 1);

      await applyDeltaPage(
        executor,
        decodeDeltaPage(decisionPage({ id, clientUpdatedAt: iso(5), decision: 'none' })),
        iso(6),
      );

      expect(await getQuickAddDecision(executor, id)).toMatchObject({ decision: 'none' });
    });

    it.each([
      ['a tombstone, which a decision never is', { deleted: true }],
      ['an unknown decision', { decision: 'starred' }],
      ['a payload naming another id', { payload: { id: 'other', ...ROUTINE, decision: 'hidden' } }],
    ])('skips %s rather than guessing, and still advances', async (_name, change) => {
      const id = await serverId();

      const outcome = await applyDeltaPage(
        executor,
        decodeDeltaPage(decisionPage({ id, clientUpdatedAt: iso(5), ...change })),
        iso(6),
      );

      expect(outcome.undecodable).toBe(1);
      expect(await listQuickAddDecisions(executor)).toEqual([]);
      expect(await getCursor(executor)).toBe('21');
    });
  });

  /**
   * #149 review: deleting the row while another change to the same button was
   * still queued left that change unbuildable forever — never sent, never in
   * the inbox, and counted as unsent on the home screen for good.
   */
  it('keeps the row when clearing a refused decision while a later one waits', async () => {
    const first = await decide('pinned', 1);
    await markRejected(executor, first.operationId, {
      reasonCode: 'PAYLOAD_FIELD_INVALID',
      field: 'id',
      rejectedAt: iso(2),
    });
    await decide('hidden', 3);

    await discardRejectedQuickAddDecision(executor, {
      rejectedOperationId: first.operationId,
      entityId: first.id,
    });

    const built = await buildPushRequest(executor, await listQueuedOperations(executor));
    expect(built.unbuildable).toEqual([]);
    expect(payloadOf(built.request.operations[0])).toMatchObject({ decision: 'hidden' });
  });

  /** §3.8: a clock refusal is fixed by sending again, stamped with the corrected clock. */
  it('sends a clock-refused decision again as a new operation stamped now', async () => {
    const { id, operationId } = await decide('pinned', 1);
    await markRejected(executor, operationId, {
      reasonCode: 'CLIENT_TIMESTAMP_OUT_OF_RANGE',
      field: 'clientTimestamp',
      rejectedAt: iso(2),
    });

    await retryRejectedQuickAddDecision(
      executor,
      { rejectedOperationId: operationId, entityId: id },
      AT(9),
    );

    const queued = await listQueuedOperations(executor);
    expect(queued).toEqual([
      expect.objectContaining({ entityId: id, operationType: 'create', clientTimestamp: iso(9) }),
    ]);
    expect(queued[0]?.operationId).not.toBe(operationId);
    expect(await getQuickAddDecision(executor, id)).toMatchObject({
      decision: 'pinned',
      clientUpdatedAt: iso(9),
    });
    expect(
      await executor.getAllAsync("SELECT * FROM sync_queue WHERE status = 'rejected';"),
    ).toEqual([]);
  });

  describe('a decision that lost to a newer one', () => {
    async function supersede(winningSequence: string): Promise<void> {
      await decide('hidden', 1);
      const built = await buildPushRequest(executor, await listQueuedOperations(executor));
      await applyPushResults(
        executor,
        built.sent,
        decodePushResults({
          results: built.request.operations.map((operation) => ({
            operationId: operation.operationId,
            entityId: operation.entityId,
            status: 'superseded',
            appliedServerSequence: winningSequence,
            replayed: false,
          })),
        } as unknown as SyncPushResponse),
        iso(2),
      );
    }

    /**
     * #149 review: this phone wrote its losing decision locally, and a cursor
     * already past the winner would never bring it back — the two phones would
     * disagree about a button indefinitely.
     */
    it('steps the cursor back so the next pull delivers the winner', async () => {
      await setCursor(executor, '50', iso(0));

      await supersede('40');

      expect(await getCursor(executor)).toBe('39');
    });

    it('never moves the cursor forward', async () => {
      await setCursor(executor, '12', iso(0));

      await supersede('40');

      expect(await getCursor(executor)).toBe('12');
    });
  });

  /**
   * The whole chain, from what the patient typed to what the server checks:
   * the entries' own spellings, grouped into widgets, decided about, and
   * pushed. The server derives the id from the payload it receives and refuses
   * any other, so the payload's id must be the derivation of the payload's own
   * fields — for "350.50", an imperial conversion, and a colour-only entry.
   */
  it('pushes, for every kind of widget, an id the server derives from the payload itself', async () => {
    const write = (code: string, value: string, system: 'metric' | 'imperial', day: number) =>
      enqueueVolumetricObservationCreate(
        executor,
        {
          code,
          valueQuantityValue: value,
          valueQuantityUnit: 'mL',
          effectiveDatetime: new Date(Date.UTC(2026, 9, 17 - day, 9)).toISOString(),
          measuredOrEstimated: 'estimated',
          enteredMeasurementSystem: system,
          fluidTypeCode: code === '9000-1' ? 'water' : null,
        },
        AT(0),
      );
    for (const day of [1, 2]) {
      await write('79560-9', '350.50', 'metric', day);
      await write('9000-1', '354.8824', 'imperial', day);
      await enqueueVolumelessUrineCreate(
        executor,
        {
          code: '9187-6',
          urineColorCode: 'pale_yellow',
          effectiveDatetime: new Date(Date.UTC(2026, 9, 17 - day, 10)).toISOString(),
          enteredMeasurementSystem: 'metric',
        },
        AT(0),
      );
    }
    await executor.runAsync('DELETE FROM sync_queue;');
    const widgets = buildQuickAddWidgets(
      await listQuickAddCandidates(executor, { codes: QUICK_ADD_CODES, since: iso(-60 * 24 * 14) }),
      [],
    ).shown;
    expect(widgets).toHaveLength(3);

    for (const widget of widgets) {
      await enqueueQuickAddDecision(
        executor,
        { profileServerId: PROFILE_ID, routine: widget.routine, decision: 'pinned' },
        AT(5),
      );
    }
    const built = await buildPushRequest(executor, await listQueuedOperations(executor));

    for (const operation of built.request.operations) {
      const payload = payloadOf(operation) as unknown as QuickAddRoutine & { id: string };
      const value = payload.valueMl;
      // What the server's precision rule demands of a JSON number.
      if (value !== null) expect(Math.round(value * 1e4) / 1e4).toBe(value);
      expect(payload.id).toBe(
        await serverId({
          code: payload.code,
          valueMl: value,
          method: payload.method,
          fluidTypeCode: payload.fluidTypeCode,
          urineColorCode: payload.urineColorCode,
          enteredMeasurementSystem: payload.enteredMeasurementSystem,
        }),
      );
    }
    expect(
      built.request.operations.map((operation) => payloadOf(operation).valueMl).sort(),
    ).toEqual([350.5, 354.8824, null]);
  });

  it('drops a refused decision and this phone’s copy of it together', async () => {
    const { id, operationId } = await decide('hidden');
    await markRejected(executor, operationId, {
      reasonCode: 'PAYLOAD_FIELD_INVALID',
      field: 'id',
      rejectedAt: iso(2),
    });

    await discardRejectedQuickAddDecision(executor, {
      rejectedOperationId: operationId,
      entityId: id,
    });

    expect(await executor.getAllAsync('SELECT * FROM sync_queue;')).toEqual([]);
    expect(await getQuickAddDecision(executor, id)).toBeUndefined();
  });

  /**
   * Builds before this one skipped `QuickAddPreference` changes and advanced
   * past them (§8), so a phone upgrading after another device decided would
   * never see those decisions. Migration 11 re-pulls once.
   */
  it('re-pulls from the start once, when a phone is upgraded to this build', async () => {
    // As a phone on the previous build would be: migrated to 10, cursor advanced.
    await executor.execAsync(
      'DROP TABLE quick_add_decisions; DELETE FROM schema_migrations WHERE version = 11;',
    );
    await setCursor(executor, '57', iso(1));

    await runMigrations(executor, AT(2));

    expect(await getCursor(executor)).toBe('0');
    expect(await listQuickAddDecisions(executor)).toEqual([]);

    // And only once: a later launch leaves the cursor where the pull put it.
    await setCursor(executor, '60', iso(3));
    await runMigrations(executor, AT(4));
    expect(await getCursor(executor)).toBe('60');
  });
});
