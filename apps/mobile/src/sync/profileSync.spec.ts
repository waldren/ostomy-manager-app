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
 * The profile's whole sync path on the device (P4.S3, `docs/sync-contract.md`
 * §7.5): an edit queued with its row, built into a push at push time, settled
 * by the push result, and a change from another device applied by the pull.
 *
 * Against a real SQLite database through the real migrations, because the
 * decisions here are about rows: which version a delta change may replace,
 * and whether the operation the push sends names the id the row holds.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SyncDeltaResponse, SyncPushResponse } from '@ostomy/core/api-client';

import type { SqliteExecutor } from '../db/executor';
import { runMigrations } from '../db/migrations';
import {
  enqueueMealDelete,
  enqueueProfileUpdate,
  undoRejectedProfileEdit,
} from '../db/offlineWrites';
import {
  readProfile,
  readProfileClientUpdatedAt,
  writeProfile,
  type LocalProfile,
} from '../db/repositories/profileRepository';
import {
  listQueuedOperations,
  listRejectedOperations,
  markRejected,
} from '../db/repositories/syncQueueRepository';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { applyDeltaPage } from './deltaPull';
import { applyPushResults, buildPushRequest } from './pushOperations';
import { decodeDeltaPage, decodePushResults } from './responseDecoding';

const FIXED_NOW = () => new Date('2026-10-16T12:00:00.000Z');
const LATER = () => new Date('2026-10-16T12:05:00.000Z');
const APPLIED_AT = '2026-10-16T12:10:00.000Z';
const SERVER_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

const SERVER_PROFILE: LocalProfile = {
  ostomyType: 'ileostomy',
  surgeryDate: '2026-09-01',
  measurementSystem: 'metric',
  serverId: SERVER_ID,
};

function profileChangePage(options: {
  clientUpdatedAt: string;
  payload?: Record<string, unknown>;
  deleted?: boolean;
}): SyncDeltaResponse {
  return {
    changes: [
      {
        entityType: 'Profile',
        entityId: SERVER_ID,
        serverSequence: '41',
        deleted: options.deleted ?? false,
        clientUpdatedAt: options.clientUpdatedAt,
        ...(options.deleted === true
          ? {}
          : {
              payload: options.payload ?? {
                id: SERVER_ID,
                ostomyType: 'colostomy',
                surgeryDate: '2026-08-20',
                measurementSystem: 'imperial',
              },
            }),
      },
    ],
    cursor: '41',
    hasMore: false,
  } as unknown as SyncDeltaResponse;
}

/** A delete carries no payload (§3.1), so the type makes reading one explicit. */
function payloadOf(operation: unknown): unknown {
  return (operation as { payload?: unknown } | undefined)?.payload;
}

describe('the profile on this device, through sync (P4.S3, §7.5)', () => {
  let dir: string;
  let executor: SqliteExecutor;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-profile-sync-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, FIXED_NOW);
    await writeProfile(executor, SERVER_PROFILE, '2026-10-01T00:00:00.000Z');
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('an edit', () => {
    it('changes the row and queues an update naming the server’s profile id, together', async () => {
      await enqueueProfileUpdate(
        executor,
        SERVER_ID,
        { ostomyType: 'ileostomy', surgeryDate: '2026-08-25', measurementSystem: 'imperial' },
        FIXED_NOW,
      );

      expect(await readProfile(executor)).toEqual({
        ...SERVER_PROFILE,
        surgeryDate: '2026-08-25',
        measurementSystem: 'imperial',
      });
      expect(await readProfileClientUpdatedAt(executor)).toBe('2026-10-16T12:00:00.000Z');
      const queued = await listQueuedOperations(executor);
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({
        entityType: 'Profile',
        entityId: SERVER_ID,
        operationType: 'update',
        clientTimestamp: '2026-10-16T12:00:00.000Z',
      });
    });

    it('is pushed as the §7.5 payload: the three answers and the id, nothing else', async () => {
      await enqueueProfileUpdate(
        executor,
        SERVER_ID,
        { ostomyType: 'colostomy', surgeryDate: '2026-08-25', measurementSystem: 'metric' },
        FIXED_NOW,
      );

      const built = await buildPushRequest(executor, await listQueuedOperations(executor));

      expect(built.unbuildable).toEqual([]);
      expect(built.request.operations).toHaveLength(1);
      expect(built.request.operations[0]).toMatchObject({
        entityType: 'Profile',
        entityId: SERVER_ID,
        operationType: 'update',
      });
      expect(payloadOf(built.request.operations[0])).toEqual({
        id: SERVER_ID,
        ostomyType: 'colostomy',
        surgeryDate: '2026-08-25',
        measurementSystem: 'metric',
      });
    });

    it('sends the latest answers when two edits are queued before a push', async () => {
      // Built at push time from the row (migration 2), so both operations carry
      // what the patient answered last — which is what a full replacement means.
      await enqueueProfileUpdate(
        executor,
        SERVER_ID,
        { ostomyType: 'ileostomy', surgeryDate: '2026-09-01', measurementSystem: 'imperial' },
        FIXED_NOW,
      );
      await enqueueProfileUpdate(
        executor,
        SERVER_ID,
        { ostomyType: 'colostomy', surgeryDate: '2026-09-01', measurementSystem: 'imperial' },
        LATER,
      );

      const built = await buildPushRequest(executor, await listQueuedOperations(executor));

      for (const operation of built.request.operations) {
        expect(payloadOf(operation)).toMatchObject({ ostomyType: 'colostomy' });
      }
    });

    it('is not built when the row no longer holds the id the operation names', async () => {
      // A re-provisioned account would otherwise send one profile's answers
      // under another profile's id.
      await enqueueProfileUpdate(
        executor,
        SERVER_ID,
        { ostomyType: 'ileostomy', surgeryDate: '2026-09-01', measurementSystem: 'imperial' },
        FIXED_NOW,
      );
      await writeProfile(
        executor,
        { ...SERVER_PROFILE, serverId: '11111111-2222-4333-8444-555555555555' },
        APPLIED_AT,
      );

      const built = await buildPushRequest(executor, await listQueuedOperations(executor));

      expect(built.request.operations).toEqual([]);
      expect(built.unbuildable).toHaveLength(1);
    });

    it('leaves the queue once the server accepts it', async () => {
      await enqueueProfileUpdate(
        executor,
        SERVER_ID,
        { ostomyType: 'ileostomy', surgeryDate: '2026-09-01', measurementSystem: 'imperial' },
        FIXED_NOW,
      );
      const built = await buildPushRequest(executor, await listQueuedOperations(executor));
      const operationId = built.request.operations[0]?.operationId;

      const outcome = await applyPushResults(
        executor,
        built.sent,
        decodePushResults({
          results: [
            {
              operationId,
              status: 'accepted',
              entityId: SERVER_ID,
              appliedServerSequence: '42',
              replayed: false,
            },
          ],
        } as unknown as SyncPushResponse),
        APPLIED_AT,
      );

      expect(outcome.accepted).toBe(1);
      expect(await listQueuedOperations(executor)).toEqual([]);
    });
  });

  /**
   * Not a profile behaviour, but the same branch: every delete was sent as an
   * `Observation`, so a meal delete would have been refused ENTITY_NOT_FOUND and
   * landed in the correction inbox as an entry nobody could see.
   */
  it('sends a queued meal delete as a Meal, not an Observation', async () => {
    await enqueueMealDelete(executor, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', FIXED_NOW);

    const built = await buildPushRequest(executor, await listQueuedOperations(executor));

    expect(built.request.operations[0]).toMatchObject({
      entityType: 'Meal',
      operationType: 'delete',
    });
  });

  describe('a change from another device', () => {
    it('replaces the server’s version on this device, and is reported so screens re-read it', async () => {
      const outcome = await applyDeltaPage(
        executor,
        decodeDeltaPage(profileChangePage({ clientUpdatedAt: '2026-10-16T11:00:00.000Z' })),
        APPLIED_AT,
      );

      expect(outcome.profileUpserts).toBe(1);
      expect(await readProfile(executor)).toEqual({
        ostomyType: 'colostomy',
        surgeryDate: '2026-08-20',
        measurementSystem: 'imperial',
        serverId: SERVER_ID,
      });
    });

    it('does not overwrite a newer edit this device has not pushed yet', async () => {
      // §9.5: the local write is the confirmation. Applying the server's older
      // version would flip the patient's answers back for one cycle.
      await enqueueProfileUpdate(
        executor,
        SERVER_ID,
        { ostomyType: 'ileostomy', surgeryDate: '2026-09-01', measurementSystem: 'imperial' },
        FIXED_NOW,
      );

      const outcome = await applyDeltaPage(
        executor,
        decodeDeltaPage(profileChangePage({ clientUpdatedAt: '2026-10-16T11:00:00.000Z' })),
        APPLIED_AT,
      );

      expect(outcome.profileUpserts).toBe(0);
      expect(outcome.skippedAsStale).toBe(1);
      expect((await readProfile(executor))?.ostomyType).toBe('ileostomy');
    });

    it('wins over an older edit from this device', async () => {
      await enqueueProfileUpdate(
        executor,
        SERVER_ID,
        { ostomyType: 'ileostomy', surgeryDate: '2026-09-01', measurementSystem: 'imperial' },
        FIXED_NOW,
      );

      await applyDeltaPage(
        executor,
        decodeDeltaPage(profileChangePage({ clientUpdatedAt: '2026-10-16T13:00:00.000Z' })),
        APPLIED_AT,
      );

      expect((await readProfile(executor))?.ostomyType).toBe('colostomy');
    });

    it('applies an unedited provisioning version, whose timestamp is the epoch placeholder', async () => {
      const outcome = await applyDeltaPage(
        executor,
        decodeDeltaPage(profileChangePage({ clientUpdatedAt: '1970-01-01T00:00:00.000Z' })),
        APPLIED_AT,
      );

      expect(outcome.profileUpserts).toBe(1);
    });

    it.each([
      ['an ostomy type v1 does not cover', { ostomyType: 'urostomy' }],
      ['a measurement system that does not exist', { measurementSystem: 'cubits' }],
      ['a surgery date that is not a calendar date', { surgeryDate: '2026-09-01T00:00:00Z' }],
    ])('skips a change carrying %s rather than storing a guess', async (_label, override) => {
      const outcome = await applyDeltaPage(
        executor,
        decodeDeltaPage(
          profileChangePage({
            clientUpdatedAt: '2026-10-16T11:00:00.000Z',
            payload: {
              id: SERVER_ID,
              ostomyType: 'colostomy',
              surgeryDate: '2026-08-20',
              measurementSystem: 'imperial',
              ...override,
            },
          }),
        ),
        APPLIED_AT,
      );

      expect(outcome.undecodable).toBe(1);
      expect(await readProfile(executor)).toEqual(SERVER_PROFILE);
    });

    it('never removes the profile on a tombstone', async () => {
      // The local profile routes the patient to their diary. Account deletion
      // purges the store (ADR-0014); a sync change does not.
      await applyDeltaPage(
        executor,
        decodeDeltaPage(
          profileChangePage({ clientUpdatedAt: '2026-10-16T11:00:00.000Z', deleted: true }),
        ),
        APPLIED_AT,
      );

      expect(await readProfile(executor)).toEqual(SERVER_PROFILE);
    });
  });

  describe('undoing an edit the server refused', () => {
    it('drops the rejected operation and puts the server’s answers back', async () => {
      const { operationId } = await enqueueProfileUpdate(
        executor,
        SERVER_ID,
        { ostomyType: 'ileostomy', surgeryDate: '1925-01-01', measurementSystem: 'metric' },
        FIXED_NOW,
      );
      await markRejected(executor, operationId, {
        reasonCode: 'PAYLOAD_FIELD_INVALID',
        field: 'surgeryDate',
        rejectedAt: APPLIED_AT,
      });

      await undoRejectedProfileEdit(
        executor,
        { rejectedOperationId: operationId, serverProfile: SERVER_PROFILE },
        LATER,
      );

      expect(await listRejectedOperations(executor)).toEqual([]);
      expect(await readProfile(executor)).toEqual(SERVER_PROFILE);
      // The server's version again, so the next delta change for it applies.
      expect(await readProfileClientUpdatedAt(executor)).toBeNull();
    });
  });
});
