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
import {
  createSyncGate,
  INITIAL_SCHEDULER_STATE,
  nextDelayMs,
  nextSchedulerState,
  SYNC_BACKOFF,
  type SchedulerState,
} from './syncScheduler';

function cycle(stoppedBecause: SyncStopReason): SyncCycleResult {
  return {
    push: { accepted: 0, superseded: 0, rejected: 0, unrecognized: 0 },
    delta: { upserts: 0, tombstones: 0, pages: 0, skippedAsStale: 0, undecodable: 0 },
    stoppedBecause,
    unbuildable: [],
    quarantined: 0,
    thresholdsRefreshed: true,
  };
}

describe('nextSchedulerState', () => {
  it('clears the failure count after a cycle that reached the server', () => {
    const failedTwice: SchedulerState = {
      consecutiveFailures: 2,
      haltedForCursorRecovery: false,
    };

    expect(nextSchedulerState(failedTwice, cycle({ kind: 'completed' }))).toEqual(
      INITIAL_SCHEDULER_STATE,
    );
  });

  it('counts an unreachable server as a failure', () => {
    const state = nextSchedulerState(INITIAL_SCHEDULER_STATE, cycle({ kind: 'unavailable' }));

    expect(state.consecutiveFailures).toBe(1);
  });

  /**
   * The server answered; the request was wrong. Backing off would treat a
   * client bug as an outage — and the worker has already quarantined the
   * operation that caused it, so the next cycle is a different request
   * rather than §6.1's forbidden unchanged retry.
   */
  it('does not back off after a protocol error, because the server was reached', () => {
    const state = nextSchedulerState(
      { consecutiveFailures: 3, haltedForCursorRecovery: false },
      cycle({ kind: 'protocol-error', code: 'ENTITY_ID_MISMATCH' }),
    );

    expect(state.consecutiveFailures).toBe(0);
  });

  it('halts scheduling once a cursor is too old, because every later pull returns the same 409', () => {
    const state = nextSchedulerState(INITIAL_SCHEDULER_STATE, cycle({ kind: 'cursor-too-old' }));

    expect(state.haltedForCursorRecovery).toBe(true);
    expect(nextDelayMs(state, { kind: 'cursor-too-old' })).toBeUndefined();
  });
});

describe('nextDelayMs', () => {
  it('schedules nothing after a successful cycle — the next trigger is an event, not a timer', () => {
    expect(nextDelayMs(INITIAL_SCHEDULER_STATE, { kind: 'completed' })).toBeUndefined();
  });

  it('grows exponentially with consecutive failures', () => {
    const delays = [1, 2, 3].map((failures) =>
      nextDelayMs(
        { consecutiveFailures: failures, haltedForCursorRecovery: false },
        { kind: 'unavailable' },
      ),
    );

    expect(delays).toEqual([
      SYNC_BACKOFF.initialMs,
      SYNC_BACKOFF.initialMs * 2,
      SYNC_BACKOFF.initialMs * 4,
    ]);
  });

  /**
   * The ceiling matters more than the curve. An offline phone must keep
   * retrying forever at some rate, because the event that ends the outage
   * may be one this app never observes — a captive portal accepted in
   * another app, a VPN reconnecting, carrier data restored.
   */
  it('stops growing at the ceiling rather than backing off without bound', () => {
    const delay = nextDelayMs(
      { consecutiveFailures: 40, haltedForCursorRecovery: false },
      { kind: 'unavailable' },
    );

    expect(delay).toBe(SYNC_BACKOFF.maxMs);
    expect(Number.isFinite(delay)).toBe(true);
  });

  it('schedules nothing while unauthenticated — sign-in drives the next cycle, not a timer', () => {
    expect(
      nextDelayMs(
        { consecutiveFailures: 5, haltedForCursorRecovery: false },
        { kind: 'unauthenticated' },
      ),
    ).toBeUndefined();
  });
});

describe('createSyncGate', () => {
  it('runs one cycle per request when nothing overlaps', async () => {
    let runs = 0;
    const gate = createSyncGate(async () => {
      runs += 1;
    });

    gate.request();
    await gate.settled();
    gate.request();
    await gate.settled();

    expect(runs).toBe(2);
  });

  /**
   * Concurrency here is a correctness problem, not a performance one: two
   * cycles read the same queued rows, both mark them in flight, and both
   * push them — and the second response settles operations the first has
   * already removed.
   */
  it('never runs two cycles concurrently', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    // One resolver per cycle, handed out in order, so the test never has to
    // guess how many microtask turns the gate needs between cycles.
    const releases: (() => void)[] = [];
    const gate = createSyncGate(async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => releases.push(resolve));
      concurrent -= 1;
    });

    gate.request();
    gate.request();

    // Drain: release each cycle as it announces itself, until the gate is
    // idle. `settled()` alone would deadlock — the cycles are waiting on us.
    while (gate.isRunning()) {
      if (releases.length > 0) releases.shift()!();
      await Promise.resolve();
    }
    await gate.settled();

    expect(maxConcurrent).toBe(1);
  });

  /** Ten connectivity events during one slow push must produce one follow-up cycle, not ten. */
  it('coalesces every request that arrives during a running cycle into exactly one follow-up', async () => {
    let runs = 0;
    const releases: (() => void)[] = [];
    const gate = createSyncGate(async () => {
      runs += 1;
      await new Promise<void>((resolve) => releases.push(resolve));
    });

    gate.request();
    // Let the first cycle actually start before the burst arrives.
    await Promise.resolve();
    for (let index = 0; index < 10; index += 1) gate.request();

    while (gate.isRunning()) {
      if (releases.length > 0) releases.shift()!();
      await Promise.resolve();
    }
    await gate.settled();

    expect(runs).toBe(2);
  });

  it('keeps accepting requests after a cycle throws', async () => {
    let runs = 0;
    const gate = createSyncGate(async () => {
      runs += 1;
      if (runs === 1) throw new Error('cycle blew up');
    });

    gate.request();
    await gate.settled();
    gate.request();
    await gate.settled();

    expect(runs).toBe(2);
    expect(gate.isRunning()).toBe(false);
  });
});
