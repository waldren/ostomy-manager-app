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

import { createApiClient } from '@ostomy/core/api-client';
import * as Network from 'expo-network';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';

import { useAuth } from '../auth/AuthContext';
import { loadEnv } from '../config/env';
import { useDatabaseState } from '../db/DatabaseProvider';
import { recoverFromStaleCursor, type StaleCursorRecoveryResult } from '../db/staleCursorRecovery';
import { now } from '../lib/utils/clock';

import {
  createSyncGate,
  INITIAL_SCHEDULER_STATE,
  nextDelayMs,
  nextSchedulerState,
  type SchedulerState,
} from './syncScheduler';
import { runSyncCycle, type SyncClientPort, type SyncStopReason } from './syncWorker';

/**
 * The triggers that make sync resume with no user action — this sprint's
 * exit criterion, which is a claim about *when* a cycle runs rather than
 * about the push loop itself.
 *
 * Four of them, and each covers a case the others miss:
 *
 *  - **Connectivity restored** (`expo-network`). The ordinary case: airplane
 *    mode off, Wi-Fi back.
 *  - **App foregrounded** (`AppState`). Covers the outage that ended while
 *    the app was backgrounded, where no listener was alive to hear it.
 *  - **Becoming authenticated.** A cycle that stopped for a missing token
 *    schedules no timer (`nextDelayMs`), so sign-in is what restarts it.
 *  - **A backoff timer.** The fallback for an outage the OS does not report
 *    as one — DNS failure, a captive portal, a server unreachable while the
 *    radio is up.
 *
 * ## What this provider deliberately does not do
 *
 * It renders nothing and exposes no save confirmation. §9.5: the local write
 * is the confirmation, and sync is invisible to the patient except when it
 * produces something to correct. `useSyncStatus` exposes counts and a stop
 * reason so a screen can show a queue depth or route to the correction
 * inbox — never so a screen can tell someone their entry was saved.
 */

export interface SyncStatus {
  readonly isRunning: boolean;
  /** Result of the most recent completed cycle, or `undefined` before the first. */
  readonly lastStop: SyncStopReason | undefined;
  /** Operations parked for correction by the most recent cycle. Cumulative counts live in the queue, not here. */
  readonly lastRejected: number;
  /** Requests a cycle now. Safe to call from anywhere: the gate coalesces. */
  readonly requestSync: () => void;
  /**
   * Performs §5.4's recovery after `lastStop.kind === 'cursor-too-old'`, then
   * resumes syncing.
   *
   * Exposed rather than run automatically, and that is the same judgement the
   * worker already makes: this discards local rows, and a background task
   * doing that silently is indistinguishable to a patient from their diary
   * emptying itself. A screen calls this once it has said what will happen.
   *
   * Unsent entries are never discarded — see `recoverFromStaleCursor`.
   */
  readonly recoverStaleCursor: () => Promise<StaleCursorRecoveryResult | undefined>;
}

const SyncContext = createContext<SyncStatus | undefined>(undefined);

export function useSyncStatus(): SyncStatus {
  const value = useContext(SyncContext);
  if (value === undefined) {
    throw new Error('useSyncStatus must be used inside a <SyncProvider>.');
  }
  return value;
}

export interface SyncProviderProps {
  readonly children: ReactNode;
  /**
   * `SYNC_PUSH_MAX_OPERATIONS` for this deployment (§3.3). Server
   * configuration; the client discovers a mismatch from a `413` and splits,
   * so a stale value costs one extra round-trip rather than breaking.
   */
  readonly maxOperationsPerBatch?: number;
  /** Test seam. Production builds the real client from `loadEnv()`. */
  readonly client?: SyncClientPort;
}

const DEFAULT_MAX_OPERATIONS_PER_BATCH = 500;

export function SyncProvider({
  children,
  maxOperationsPerBatch = DEFAULT_MAX_OPERATIONS_PER_BATCH,
  client,
}: SyncProviderProps): React.JSX.Element {
  const { phase, accessToken } = useAuth();
  const database = useDatabaseState();

  const [isRunning, setIsRunning] = useState(false);
  const [lastStop, setLastStop] = useState<SyncStopReason | undefined>(undefined);
  const [lastRejected, setLastRejected] = useState(0);

  const schedulerRef = useRef<SchedulerState>(INITIAL_SCHEDULER_STATE);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Read through a ref inside the cycle rather than captured in the closure:
  // the gate holds one `run` for its lifetime, and a token captured at mount
  // would be the one this app had before its first refresh.
  const accessTokenRef = useRef<string | undefined>(accessToken);
  accessTokenRef.current = accessToken;

  const port = useMemo<SyncClientPort | undefined>(() => {
    if (client) return client;
    const api = createApiClient({
      baseUrl: loadEnv().apiUrl,
      getAccessToken: () => accessTokenRef.current,
    });
    return {
      push: (request) => api.sync.push(request as Parameters<typeof api.sync.push>[0]),
      delta: (query) => api.sync.delta(query as Parameters<typeof api.sync.delta>[0]),
      thresholds: () => api.thresholds.get(),
      valueSets: () => api.valueSets.get(),
    };
  }, [client]);

  const executor = database.status === 'ready' ? database.executor : undefined;
  const canSync = phase === 'authenticated' && executor !== undefined && port !== undefined;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== undefined) {
      clearTimeout(timerRef.current);
      timerRef.current = undefined;
    }
  }, []);

  const gate = useMemo(
    () =>
      createSyncGate(async () => {
        if (executor === undefined || port === undefined) return;
        setIsRunning(true);
        try {
          const result = await runSyncCycle({
            executor,
            client: port,
            now,
            maxOperationsPerBatch,
          });
          schedulerRef.current = nextSchedulerState(schedulerRef.current, result);
          setLastStop(result.stoppedBecause);
          setLastRejected(result.push.rejected + result.quarantined);

          const delay = nextDelayMs(schedulerRef.current, result.stoppedBecause);
          clearTimer();
          if (delay !== undefined) {
            timerRef.current = setTimeout(() => gateRef.current?.request(), delay);
          }
        } catch {
          // A cycle must never take the app down. `runSyncCycle` already
          // converts every expected failure into a stop reason; this is the
          // backstop for the unexpected one — a corrupt local row, a
          // migration mid-flight. Nothing is logged: a sync failure's
          // diagnostics are derived from clinical rows, and §6.3/§9.8 forbid
          // carrying that off the device. The queue is unchanged, so the
          // next trigger retries.
          schedulerRef.current = {
            consecutiveFailures: schedulerRef.current.consecutiveFailures + 1,
            haltedForCursorRecovery: schedulerRef.current.haltedForCursorRecovery,
          };
        } finally {
          setIsRunning(false);
        }
      }),
    [executor, port, maxOperationsPerBatch, clearTimer],
  );

  // The gate is rebuilt whenever the database or client identity changes;
  // the backoff timer fires later and must reach the CURRENT gate.
  const gateRef = useRef(gate);
  gateRef.current = gate;

  const requestSync = useCallback(() => {
    if (!canSync) return;
    gateRef.current.request();
  }, [canSync]);

  const recoverStaleCursor = useCallback(async () => {
    if (executor === undefined) return undefined;
    const outcome = await recoverFromStaleCursor(executor, now);
    // Clearing the halt is what makes the recovery complete rather than
    // merely performed: `nextDelayMs` schedules nothing while the scheduler
    // is halted, so without this the device would sit with a fresh cursor
    // and never pull against it.
    schedulerRef.current = { ...schedulerRef.current, haltedForCursorRecovery: false };
    setLastStop(undefined);
    gateRef.current.request();
    return outcome;
  }, [executor]);

  // Trigger 1 and 3: a usable database plus an authenticated session. Also
  // covers app launch with a queue left over from a previous run, which is
  // the "survives restart, resumes with no user action" half of the exit
  // criterion.
  useEffect(() => {
    if (!canSync) return;
    requestSync();
  }, [canSync, requestSync]);

  // Trigger 2: connectivity restored.
  useEffect(() => {
    if (!canSync) return;
    const subscription = Network.addNetworkStateListener((state) => {
      // `isInternetReachable` is deliberately not required to be `true`:
      // it is `undefined` on platforms and moments where the OS has not
      // probed yet, and treating that as "offline" means a phone that is
      // genuinely online never syncs. An attempt that fails costs one
      // request and feeds the backoff; a missed trigger costs the patient
      // their backlog until something else wakes the app.
      if (state.isConnected === true) requestSync();
    });
    return () => {
      subscription.remove();
    };
  }, [canSync, requestSync]);

  // Trigger 4: the app comes back to the foreground.
  useEffect(() => {
    if (!canSync) return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') requestSync();
    });
    return () => {
      subscription.remove();
    };
  }, [canSync, requestSync]);

  useEffect(() => clearTimer, [clearTimer]);

  const value = useMemo<SyncStatus>(
    () => ({ isRunning, lastStop, lastRejected, requestSync, recoverStaleCursor }),
    [isRunning, lastStop, lastRejected, requestSync, recoverStaleCursor],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
