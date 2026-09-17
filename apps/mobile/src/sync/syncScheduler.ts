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

import type { SyncCycleResult, SyncStopReason } from './syncWorker';

/**
 * When a sync cycle runs, and what stops it running again immediately.
 *
 * Split out from `syncWorker.ts` and kept free of React, `expo-network` and
 * timers so the policy is testable as a pure state machine. The parts that
 * touch the platform are `SyncProvider.tsx`'s job; everything that decides
 * *whether* and *when* is here.
 *
 * The sprint exit criterion this serves is "sync resumes with no user
 * action" — which is a claim about triggers, not about the push loop.
 */

/**
 * Backoff after a cycle that could not reach the server.
 *
 * Exponential with a ceiling, and the ceiling matters more than the curve:
 * an offline phone must keep retrying forever at *some* rate, because the
 * only event that ends the outage may be one this app never observes (a
 * captive portal accepted in another app, a VPN reconnecting, carrier data
 * restored). A backoff that grows without bound turns a patient who was
 * offline overnight into a patient whose backlog waits hours after the
 * connection returns.
 *
 * The connectivity listener normally beats this timer to it. This is the
 * fallback for the outage the OS does not report as one: DNS failure,
 * captive portal, or a server that is unreachable while the radio is up.
 */
export const SYNC_BACKOFF = {
  initialMs: 5_000,
  maxMs: 5 * 60_000,
  multiplier: 2,
} as const;

export interface SchedulerState {
  /** Consecutive cycles that ended without reaching the server. Reset by any cycle that did. */
  readonly consecutiveFailures: number;
  /**
   * Set once a cycle reports `cursor-too-old`. No further cycle is scheduled
   * until the app performs §5.4's wipe-and-resync recovery, because every
   * subsequent delta request returns the same `409` and a timer would spin
   * on it indefinitely.
   */
  readonly haltedForCursorRecovery: boolean;
}

export const INITIAL_SCHEDULER_STATE: SchedulerState = {
  consecutiveFailures: 0,
  haltedForCursorRecovery: false,
};

/**
 * Whether a cycle reached the server at all.
 *
 * `protocol-error` counts as reached: the server answered, and the problem
 * is this client's request. Backing off on it would be treating a client bug
 * as an outage — and the worker has already quarantined the operation that
 * caused it, so the next cycle is a genuinely different request rather than
 * §6.1's forbidden unchanged retry.
 */
function reachedServer(reason: SyncStopReason): boolean {
  return reason.kind !== 'unavailable';
}

export function nextSchedulerState(state: SchedulerState, result: SyncCycleResult): SchedulerState {
  if (result.stoppedBecause.kind === 'cursor-too-old') {
    return { consecutiveFailures: 0, haltedForCursorRecovery: true };
  }
  if (reachedServer(result.stoppedBecause)) {
    return { consecutiveFailures: 0, haltedForCursorRecovery: false };
  }
  return {
    consecutiveFailures: state.consecutiveFailures + 1,
    haltedForCursorRecovery: false,
  };
}

/**
 * Milliseconds until the next automatic attempt, or `undefined` when none
 * should be scheduled.
 *
 * `undefined` for an unauthenticated stop as well as for a cursor halt:
 * re-authentication is a user-visible event the auth layer already drives,
 * and retrying on a timer against a missing token produces nothing but
 * failed requests on a metered connection. The next cycle comes from the
 * sign-in completing, which `SyncProvider` observes.
 */
export function nextDelayMs(state: SchedulerState, lastStop: SyncStopReason): number | undefined {
  if (state.haltedForCursorRecovery) return undefined;
  if (lastStop.kind === 'unauthenticated') return undefined;
  if (state.consecutiveFailures === 0) return undefined;

  const exponent = state.consecutiveFailures - 1;
  const raw = SYNC_BACKOFF.initialMs * Math.pow(SYNC_BACKOFF.multiplier, exponent);
  return Math.min(raw, SYNC_BACKOFF.maxMs);
}

/**
 * Serialises cycles so two triggers cannot run one concurrently.
 *
 * Concurrency here is not a performance concern, it is a correctness one:
 * two cycles read the same `queued` rows, both mark them in flight, and both
 * push them. Idempotency (§3.7) means the server applies the write once —
 * but the second response's `accepted` result arrives for an operation the
 * first cycle has already removed from the queue, and the delta cursor can
 * be advanced by two pulls interleaved in either order.
 *
 * A coalescing gate rather than a queue: a trigger that arrives while a
 * cycle is running sets a flag, and exactly one further cycle runs
 * afterwards. Ten connectivity events during one slow push produce one
 * follow-up cycle, not ten.
 */
export function createSyncGate(run: () => Promise<void>): {
  request: () => void;
  readonly isRunning: () => boolean;
  /** Resolves when no cycle is running and none is pending. Test-only affordance. */
  settled: () => Promise<void>;
} {
  let running = false;
  let pending = false;
  let inFlight: Promise<void> = Promise.resolve();

  function drain(): void {
    if (running) {
      pending = true;
      return;
    }
    running = true;
    inFlight = (async () => {
      try {
        do {
          pending = false;
          await run();
        } while (pending);
      } finally {
        running = false;
      }
    })();
    // A rejected cycle must not become an unhandled rejection: `run` is
    // expected to absorb its own errors, and this is the backstop for the
    // one that does not.
    void inFlight.catch(() => undefined);
  }

  return {
    request: drain,
    isRunning: () => running,
    settled: async () => {
      await inFlight.catch(() => undefined);
    },
  };
}
