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
 * Tests for the sync triggers — the part of "sync resumes with no user
 * action" that lives in the provider rather than in the worker.
 *
 * `runSyncCycle` is mocked here on purpose. What this file is asserting is
 * *when* a cycle runs, and running the real worker would make every one of
 * these tests depend on the wire behaviour that `syncWorker.spec.ts` already
 * covers against a real SQLite engine.
 */

import { act, render, screen, waitFor } from '@testing-library/react-native';
import { AppState } from 'react-native';
import { Text } from 'react-native';

import { SyncProvider, useSyncStatus } from './SyncProvider';
import type { SyncCycleResult } from './syncWorker';

const mockRunSyncCycle = jest.fn();
const mockAddNetworkStateListener = jest.fn();

jest.mock('./syncWorker', () => ({
  runSyncCycle: (...args: unknown[]) => mockRunSyncCycle(...args),
}));

// The subscription is built in the factory rather than through a per-test
// `mockReturnValue`, so it can never be `undefined` at unmount: the effect
// cleanup calls `subscription.remove()`, and a cleanup that throws surfaces
// inside whichever later test happens to trigger the unmount.
jest.mock('expo-network', () => ({
  addNetworkStateListener: (listener: unknown) => {
    mockAddNetworkStateListener(listener);
    return { remove: jest.fn() };
  },
}));

// jest-expo's `AppState` stub returns nothing from `addEventListener`, so
// the effect cleanup's `subscription.remove()` throws at unmount — and a
// cleanup that throws surfaces inside whichever LATER test triggers the
// unmount, which is why this is spied for every test rather than only for
// the one that reads the handler. Production `AppState` always returns a
// subscription; the stub is what does not.
let appStateHandler: ((state: string) => void) | undefined;

const mockAuth = { phase: 'authenticated' as string, accessToken: 'token' as string | undefined };
jest.mock('../auth/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

const fakeExecutor = {
  execAsync: jest.fn(),
  runAsync: jest.fn(),
  getAllAsync: jest.fn(),
  withTransactionAsync: jest.fn(),
  closeAsync: jest.fn(),
};
const mockDatabase = { status: 'ready' as string, executor: fakeExecutor };
jest.mock('../db/DatabaseProvider', () => ({
  useDatabaseState: () => mockDatabase,
}));

function completedCycle(overrides: Partial<SyncCycleResult> = {}): SyncCycleResult {
  return {
    push: { accepted: 0, superseded: 0, rejected: 0, unrecognized: 0 },
    delta: {
      upserts: 0,
      tombstones: 0,
      pages: 0,
      skippedAsStale: 0,
      undecodable: 0,
      unsupportedEntity: 0,
    },
    stoppedBecause: { kind: 'completed' },
    unbuildable: [],
    quarantined: 0,
    thresholdsRefreshed: true,
    valueSetsRefreshed: true,
    ...overrides,
  };
}

function Probe() {
  const { lastRejected, lastStop } = useSyncStatus();
  return <Text testID="status">{`${lastStop?.kind ?? 'none'}:${String(lastRejected)}`}</Text>;
}

// `render` is asynchronous in this version of the testing library, so it
// must be awaited — an un-awaited render mounts after the test body has run
// and after cleanup has unmounted the tree, so no effect ever fires.
async function renderProvider(): Promise<void> {
  await render(
    <SyncProvider
      client={{ push: jest.fn(), delta: jest.fn(), thresholds: jest.fn(), valueSets: jest.fn() }}
    >
      <Probe />
    </SyncProvider>,
  );
}

describe('SyncProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.phase = 'authenticated';
    mockAuth.accessToken = 'token';
    mockDatabase.status = 'ready';
    mockRunSyncCycle.mockResolvedValue(completedCycle());
    appStateHandler = undefined;
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      type: string,
      handler: (state: string) => void,
    ) => {
      if (type === 'change') appStateHandler = handler;
      return { remove: jest.fn() };
    }) as unknown as typeof AppState.addEventListener);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /**
   * The "survives app restart, resumes with no user action" half of the
   * exit criterion: a queue left over from a previous run drains without
   * anyone tapping anything.
   */
  it('runs a cycle as soon as the database is ready and the session is authenticated', async () => {
    await renderProvider();

    await waitFor(() => {
      expect(mockRunSyncCycle).toHaveBeenCalledTimes(1);
    });
  });

  it('does not sync while the session is not authenticated', async () => {
    mockAuth.phase = 'locked';

    await renderProvider();

    await act(async () => undefined);
    expect(mockRunSyncCycle).not.toHaveBeenCalled();
  });

  it('does not sync before the local database is open', async () => {
    mockDatabase.status = 'opening';

    await renderProvider();

    await act(async () => undefined);
    expect(mockRunSyncCycle).not.toHaveBeenCalled();
  });

  it('runs a cycle when connectivity is restored', async () => {
    await renderProvider();
    await waitFor(() => {
      expect(mockRunSyncCycle).toHaveBeenCalledTimes(1);
    });

    const listener = mockAddNetworkStateListener.mock.calls[0]![0] as (state: unknown) => void;
    await act(async () => {
      listener({ isConnected: true, isInternetReachable: true });
    });

    await waitFor(() => {
      expect(mockRunSyncCycle).toHaveBeenCalledTimes(2);
    });
  });

  it('does not run a cycle when the radio goes down', async () => {
    await renderProvider();
    await waitFor(() => {
      expect(mockRunSyncCycle).toHaveBeenCalledTimes(1);
    });

    const listener = mockAddNetworkStateListener.mock.calls[0]![0] as (state: unknown) => void;
    await act(async () => {
      listener({ isConnected: false, isInternetReachable: false });
    });

    expect(mockRunSyncCycle).toHaveBeenCalledTimes(1);
  });

  /**
   * `isInternetReachable` is `undefined` on platforms and moments where the
   * OS has not probed yet. Treating that as offline means a phone that is
   * genuinely online never syncs — a missed trigger costs the patient their
   * backlog, while a failed attempt costs one request.
   */
  it('syncs on a connected state whose reachability the OS has not determined', async () => {
    await renderProvider();
    await waitFor(() => {
      expect(mockRunSyncCycle).toHaveBeenCalledTimes(1);
    });

    const listener = mockAddNetworkStateListener.mock.calls[0]![0] as (state: unknown) => void;
    await act(async () => {
      listener({ isConnected: true, isInternetReachable: undefined });
    });

    await waitFor(() => {
      expect(mockRunSyncCycle).toHaveBeenCalledTimes(2);
    });
  });

  /** Covers the outage that ended while the app was backgrounded, where no listener was alive to hear it. */
  it('runs a cycle when the app returns to the foreground', async () => {
    await renderProvider();
    await waitFor(() => {
      expect(mockRunSyncCycle).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      appStateHandler?.('active');
    });

    await waitFor(() => {
      expect(mockRunSyncCycle).toHaveBeenCalledTimes(2);
    });
  });

  it('does not run a cycle when the app merely goes to the background', async () => {
    await renderProvider();
    await waitFor(() => {
      expect(mockRunSyncCycle).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      appStateHandler?.('background');
    });

    expect(mockRunSyncCycle).toHaveBeenCalledTimes(1);
  });

  it('exposes the stop reason and the count parked for correction', async () => {
    mockRunSyncCycle.mockResolvedValue(
      completedCycle({
        push: { accepted: 2, superseded: 0, rejected: 1, unrecognized: 0 },
        quarantined: 1,
      }),
    );

    await renderProvider();

    await waitFor(() => {
      expect(screen.getByTestId('status')).toHaveTextContent('completed:2');
    });
  });

  /**
   * A sync failure's diagnostics are derived from clinical rows, and
   * §6.3/§9.8 forbid carrying those off the device — so the backstop
   * swallows rather than logs. What it must not do is take the app down.
   */
  it('survives a cycle that throws rather than crashing the app', async () => {
    mockRunSyncCycle.mockRejectedValue(new Error('unexpected'));

    await renderProvider();

    await waitFor(() => {
      expect(mockRunSyncCycle).toHaveBeenCalled();
    });
    expect(screen.getByTestId('status')).toBeTruthy();
  });
});
