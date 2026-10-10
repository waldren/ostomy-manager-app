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
 * The home screen's unsent count, after a sync cycle that sends something.
 *
 * Found by the #122 emulator pass rather than by this suite, which did not
 * exist: `app/home.tsx` had no component test at all, and the defect lived in
 * an effect's dependency list, which is invisible to every other kind of test.
 *
 * The screen read "1 entry has not been sent yet" minutes after the row was
 * confirmed on the server, and it never cleared. The cause was that the count
 * refreshed on `lastRejected` alone — a value that moves only when a cycle
 * parks something for correction — so the ordinary outcome, a clean push,
 * refreshed nothing and nothing else remounts this screen.
 *
 * Why it is worth a test rather than a one-line fix and a shrug: this is the
 * only thing the app tells a patient about whether their care team has their
 * entries, the same count gates the sign-out warning, and being stuck on
 * "not sent" is the direction that both alarms a patient who is fine and
 * teaches them to ignore the message on the day it is true.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../i18n/i18n';

import { act, render, screen } from '@testing-library/react-native';

import Home from '../../app/home';
import { runMigrations } from '../db/migrations';
import { writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import { enqueueOperation } from '../db/repositories/syncQueueRepository';
import type { SqliteExecutor } from '../db/executor';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';
import { ProfileProvider } from '../onboarding/ProfileProvider';
import type { ProfilePort } from '../onboarding/provisionProfile';

jest.setTimeout(30_000);

const PROFILE: LocalProfile = {
  ostomyType: 'ileostomy',
  surgeryDate: '2026-09-01',
  measurementSystem: 'metric',
};

const mockAuth = {
  phase: 'authenticated',
  getFreshAccessToken: async () => 'token',
  signOut: jest.fn(),
};
jest.mock('../auth/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

let mockExecutor: SqliteExecutor;

/** One stable object with the executor behind a getter — see `imperialEntry.spec.tsx` for why identity matters here. */
const mockDatabaseState = {
  status: 'ready' as const,
  get executor(): SqliteExecutor {
    return mockExecutor;
  },
};
jest.mock('../db/DatabaseProvider', () => ({
  useDatabaseState: () => mockDatabaseState,
  useDatabase: () => mockDatabaseState.executor,
}));

jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
    useLocalSearchParams: () => ({}),
    Redirect: ({ href }: { href: string }) => <Text>{`redirect:${href}`}</Text>,
  };
});

/**
 * A mutable sync status, so a test can drive a cycle the way the provider does.
 *
 * `isRunning` is set inside the cycle's `finally`, so it falls back to `false`
 * once per cycle whatever the outcome — which is exactly why it, and not
 * `lastRejected`, is the signal a clean push can be observed through.
 */
const mockSyncStatus = {
  isRunning: false,
  lastRejected: 0,
  lastStop: undefined as unknown,
  requestSync: jest.fn(),
  recoverStaleCursor: jest.fn(),
};
jest.mock('./SyncProvider', () => ({
  useSyncStatus: () => mockSyncStatus,
}));

const port: ProfilePort = {
  provision: () => Promise.resolve(PROFILE),
  read: () => Promise.resolve(PROFILE),
};

/**
 * A fresh element each time, because `rerender` with the same element object
 * bails out before the component runs.
 */
function tree(): React.JSX.Element {
  return (
    <ProfileProvider port={port}>
      <Home />
    </ProfileProvider>
  );
}

async function renderHome(): Promise<void> {
  await writeProfile(mockExecutor, PROFILE, '2026-10-10T12:00:00.000Z');
  await act(async () => {
    render(tree());
  });
}

/** `screen` holds the active render result in RNTL 14; `render`'s return no longer carries it. */
function rerenderHome(): void {
  screen.rerender(tree());
}

/**
 * One cycle, as the provider runs it: `isRunning` true, then false in the
 * `finally`.
 *
 * The re-render is explicit here because the mocked status is a plain object
 * rather than provider state — in the app, `setIsRunning` is what re-renders
 * this screen. What is under test is whether the refresh effect reacts to the
 * flag at all, which is the part that was wrong.
 */
async function runSyncCycle(drain: () => Promise<void>): Promise<void> {
  await act(async () => {
    mockSyncStatus.isRunning = true;
    rerenderHome();
  });
  await drain();
  await act(async () => {
    mockSyncStatus.isRunning = false;
    rerenderHome();
  });
}

describe('the home screen’s unsent count', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-pending-'));
    mockExecutor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(mockExecutor, () => new Date('2026-10-10T12:00:00.000Z'));
    mockSyncStatus.isRunning = false;
    mockSyncStatus.lastRejected = 0;
  });

  afterEach(async () => {
    await mockExecutor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  async function queueOne(operationId: string): Promise<void> {
    await enqueueOperation(
      mockExecutor,
      {
        operationId,
        entityType: 'Observation',
        entityId: `entity-${operationId}`,
        operationType: 'create',
        clientTimestamp: '2026-10-10T12:00:00.000Z',
      },
      '2026-10-10T12:00:00.000Z',
    );
  }

  it('says an entry is unsent while it is still queued', async () => {
    await queueOne('op-1');
    await renderHome();

    expect(screen.getByText('1 entry has not been sent yet.')).toBeTruthy();
  });

  /**
   * The regression. A cycle that sends everything and rejects nothing leaves
   * `lastRejected` untouched, which is what let the stale count survive.
   */
  it('clears once a cycle sends it, with nothing rejected', async () => {
    await queueOne('op-1');
    await renderHome();
    expect(screen.getByText('1 entry has not been sent yet.')).toBeTruthy();

    await runSyncCycle(async () => {
      await mockExecutor.runAsync('DELETE FROM sync_queue;');
    });

    expect(screen.getByText('Everything is saved and sent.')).toBeTruthy();
    expect(screen.queryByText('1 entry has not been sent yet.')).toBeNull();
  });

  /** The count must also go up on its own, not only down: a cycle that quarantines rather than drains. */
  it('still counts an entry the cycle could not send', async () => {
    await queueOne('op-1');
    await queueOne('op-2');
    await renderHome();

    await runSyncCycle(async () => {
      await mockExecutor.runAsync("DELETE FROM sync_queue WHERE operation_id = 'op-1';");
    });

    expect(screen.getByText('1 entry has not been sent yet.')).toBeTruthy();
  });
});
