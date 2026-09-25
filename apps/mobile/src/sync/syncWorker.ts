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

import { ApiError, MissingAccessTokenError } from '@ostomy/core/api-client';
import type { SyncDeltaResponse, SyncPushResponse } from '@ostomy/core/api-client';
import type { SyncProtocolErrorCode } from '@ostomy/core/sync';
import { isSyncProtocolErrorCode } from '@ostomy/core/sync';

import type { SqliteExecutor } from '../db/executor';
import { getCursor } from '../db/repositories/syncCursorRepository';
import { writeThresholds } from '../db/repositories/thresholdsRepository';
import { writeValueSets } from '../db/repositories/valueSetsRepository';
import { listQueuedOperations, markQuarantined } from '../db/repositories/syncQueueRepository';
import type { SyncQueueEntry } from '../db/types';

import { splitIntoPushBatches } from './batching';
import { applyDeltaPage, type DeltaOutcome } from './deltaPull';
import { decodeDeltaPage, decodePushResults } from './responseDecoding';
import {
  applyPushResults,
  buildPushRequest,
  markBatchInFlight,
  returnBatchToQueue,
  type PushOutcome,
  type UnbuildableOperation,
} from './pushOperations';

/**
 * One sync cycle: drain the push queue, then pull the delta to exhaustion.
 *
 * ## Push first, then pull
 *
 * Deliberate, and not merely "writes are more urgent". The delta pull
 * applies the server's version of an entity over this device's
 * (`deltaPull.ts`), and that comparison is only meaningful against settled
 * state. Pulling first means a page computed *before* this device's queued
 * write reaches the server arrives carrying the older server version, the
 * local row loses the comparison only because the push had not happened
 * yet, and the patient watches an entry they were told was saved change
 * under them and then change back one cycle later.
 *
 * ## Nothing here is ever shown as a save confirmation
 *
 * §9.5: the local write is the confirmation, and sync is invisible to the
 * patient except when it produces something to correct. This module returns
 * counts so a caller can render a queue depth — it must never be wired to
 * anything that reads as "your entry was saved".
 *
 * ## Every failure path in one place
 *
 * §9.3 is the rule the rest of this file is shaped around: a `5xx` or a
 * network failure is **not** a rejection. The operation's fate is unknown,
 * it goes back on the queue, and idempotency (§3.7) settles it on the next
 * attempt. Only a `rejected` result inside a `200` is a rejection, and only
 * `applyPushResults` may record one.
 */

/**
 * How many pushes an unrecognised §6.1 code survives before the batch is
 * isolated.
 *
 * Not a threshold anyone tuned — it is the smallest number that makes the two
 * failure modes distinguishable. A server that has added a code this build does
 * not know needs the client to wait for an update, not to reject the patient's
 * entries; a genuine client bug needs to reach the correction inbox rather than
 * retry forever (§9.2). Three cycles separates them without leaving a real bug
 * unaddressed for long.
 *
 * Not a validation threshold, so not admin-managed configuration: this bounds
 * transport retries, the same reasoning that keeps `SYNC_PUSH_MAX_OPERATIONS`
 * out of `validation_thresholds`.
 */
const UNKNOWN_PROTOCOL_CODE_RETRY_LIMIT = 3;

/** Why a cycle stopped. Counts and codes only — never an operation's content (§6.3). */
export type SyncStopReason =
  /** Queue drained and the delta pull reached `hasMore: false`. */
  | { readonly kind: 'completed' }
  /** No usable access token. Local entry is unaffected; the auth layer owns recovery. */
  | { readonly kind: 'unauthenticated' }
  /** Transport failure or a `5xx`. Everything in flight went back on the queue. */
  | { readonly kind: 'unavailable' }
  /**
   * §5.4: this device's cursor predates the tombstone purge horizon, so the
   * server can no longer prove it has seen every change. Recovery is to wipe
   * local entity state and re-sync from `since=0` — which this worker
   * deliberately does NOT do on its own; see `runSyncCycle`.
   */
  | { readonly kind: 'cursor-too-old' }
  /**
   * The token is valid and this patient has no record on the server yet
   * (§6.1 `PATIENT_NOT_PROVISIONED`, #80).
   *
   * Distinct from `unauthenticated`, and the distinction is the entire point.
   * Re-authenticating succeeds and changes nothing, so treating this as an auth
   * failure produced a loop: sign in, sync, be refused, sign in. Distinct from
   * `unavailable` too — nothing is retried, because time does not fix it.
   *
   * The queue is deliberately left exactly as it is. Nothing is wrong with the
   * operations in it and nothing is quarantined: they are correct entries
   * waiting for a record to attach to, and they push normally once it exists.
   */
  | { readonly kind: 'not-provisioned' }
  /** A protocol error (§6.1) that survived isolation down to a single operation. */
  | { readonly kind: 'protocol-error'; readonly code: SyncProtocolErrorCode };

export interface SyncCycleResult {
  readonly push: PushOutcome;
  readonly delta: DeltaOutcome;
  readonly stoppedBecause: SyncStopReason;
  /** Operations that could not be built into a wire payload. Left on the queue; see `UnbuildableOperation`. */
  readonly unbuildable: readonly UnbuildableOperation[];
  /** Operations quarantined after a protocol error isolated to them alone. */
  readonly quarantined: number;
  /** Whether this cycle refreshed the cached validation thresholds. A `false` leaves the previous cached copy in force; it is not an error. */
  readonly thresholdsRefreshed: boolean;
  /** Whether this cycle refreshed the cached value sets. Same shape, same non-error semantics. */
  readonly valueSetsRefreshed: boolean;
}

/**
 * The two calls this worker needs, typed as the **generated** client returns
 * them rather than as `docs/sync-contract.md` models them.
 *
 * That is deliberate and is the honest shape of the seam: OpenAPI cannot
 * express the contract's discriminated unions, so the generated types have
 * every union member optional. Declaring this port in the strict
 * `packages/core/src/sync` types would mean asserting the invariants rather
 * than checking them — `responseDecoding.ts` checks them instead, once, at
 * the boundary.
 *
 * `limit` is a string because the generated client spells query parameters
 * as strings (§7.3 already requires the sequence values to be).
 */
export interface SyncClientPort {
  push(request: { readonly operations: readonly unknown[] }): Promise<SyncPushResponse>;
  delta(query: { readonly since: string; readonly limit?: string }): Promise<SyncDeltaResponse>;
  /**
   * `GET /api/v1/thresholds`. Not part of the sync contract — it carries no
   * PHI and has no cursor, ordering or idempotency semantics — but it rides
   * the same cycle because it needs the same trigger: the device must have a
   * usable copy before the patient opens an entry screen offline, and the
   * connectivity events that drain the queue are exactly the moments a fresh
   * copy is obtainable.
   */
  thresholds(): Promise<{
    readonly stomaOutputSoftWarningMl: number;
    readonly maxClockSkewMs: number;
  }>;
  /**
   * `GET /api/v1/value-sets`. Rides the same cycle as the thresholds refresh
   * and for the same reason: the entry screens must be able to render their
   * pickers offline, so the members have to be on the device before the
   * patient opens one.
   */
  valueSets(): Promise<{
    readonly valueSets: ReadonlyArray<{
      readonly key: string;
      readonly members: ReadonlyArray<{
        readonly code: string;
        readonly sortOrder: number;
        readonly numericValue: number | null;
        readonly numericUnit: string | null;
      }>;
    }>;
  }>;
}

export interface SyncCycleDeps {
  readonly executor: SqliteExecutor;
  readonly client: SyncClientPort;
  readonly now: () => Date;
  /**
   * `SYNC_PUSH_MAX_OPERATIONS` as this build is configured. Server
   * configuration (§3.3), passed in rather than defaulted here — see
   * `batching.ts`'s `BatchingOptions` for why a client-side default is a
   * second source of truth.
   */
  readonly maxOperationsPerBatch: number;
  /** Delta page size to request. The server clamps it (§5.1), so a too-large value is safe and a `400` is impossible. */
  readonly deltaPageSize?: string;
}

const EMPTY_PUSH: PushOutcome = { accepted: 0, superseded: 0, rejected: 0, unrecognized: 0 };
const EMPTY_DELTA: DeltaOutcome = {
  upserts: 0,
  tombstones: 0,
  pages: 0,
  skippedAsStale: 0,
  undecodable: 0,
  unsupportedEntity: 0,
};

export async function runSyncCycle(deps: SyncCycleDeps): Promise<SyncCycleResult> {
  const push = await runPushPhase(deps);

  // A push phase that stopped for auth or transport reasons stops the cycle:
  // the pull would fail for the same reason, and one failed request per
  // cycle is enough to learn that from.
  if (push.stoppedBecause.kind !== 'completed') {
    return {
      push: push.outcome,
      delta: EMPTY_DELTA,
      stoppedBecause: push.stoppedBecause,
      unbuildable: push.unbuildable,
      quarantined: push.quarantined,
      // A cycle that could not reach the server for the push will not reach
      // it for this either; skipped rather than attempted so an offline
      // device does not make a doomed request per cycle.
      thresholdsRefreshed: false,
      valueSetsRefreshed: false,
    };
  }

  const delta = await runDeltaPhase(deps);
  const thresholdsRefreshed = await refreshThresholds(deps);
  const valueSetsRefreshed = await refreshValueSets(deps);

  return {
    push: push.outcome,
    delta: delta.outcome,
    stoppedBecause: delta.stoppedBecause,
    unbuildable: push.unbuildable,
    quarantined: push.quarantined,
    thresholdsRefreshed,
    valueSetsRefreshed,
  };
}

/**
 * Refreshes the cached value sets, and never fails the cycle — the threshold
 * refresh's reasoning applies unchanged.
 *
 * A failure leaves the PREVIOUS cached copy in place, which is exactly what an
 * offline device renders from anyway. What it must never do is stop a
 * patient's queued entries reaching the server.
 */
async function refreshValueSets(deps: SyncCycleDeps): Promise<boolean> {
  try {
    const fetched = await deps.client.valueSets();
    await writeValueSets(
      deps.executor,
      fetched.valueSets.map((set) => ({
        key: set.key,
        // Named field by field rather than spread: the response type is
        // generated and free to grow, and this cache's columns are not.
        members: set.members.map((member) => ({
          code: member.code,
          sortOrder: member.sortOrder,
          numericValue: member.numericValue,
          numericUnit: member.numericUnit,
        })),
      })),
      deps.now().toISOString(),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Refreshes the cached validation thresholds, and never fails the cycle.
 *
 * Last in the cycle and swallowing its own errors, both deliberately. A
 * patient's queued entries reaching the server matters more than this app's
 * copy of a configuration number being current, so a threshold fetch must
 * never be the reason a push did not happen — and a failure here leaves the
 * PREVIOUS cached copy in place, which is exactly what an offline device
 * validates against anyway.
 *
 * AC 13.2 AC2 is what this serves: an admin changes a threshold and it
 * governs from the next successful fetch, with no application release.
 */
async function refreshThresholds(deps: SyncCycleDeps): Promise<boolean> {
  try {
    const fetched = await deps.client.thresholds();
    await writeThresholds(
      deps.executor,
      {
        softWarningMaxMl: fetched.stomaOutputSoftWarningMl,
        maxClockSkewMs: fetched.maxClockSkewMs,
      },
      deps.now().toISOString(),
    );
    return true;
  } catch {
    return false;
  }
}

interface PushPhaseResult {
  readonly outcome: PushOutcome;
  readonly stoppedBecause: SyncStopReason;
  readonly unbuildable: readonly UnbuildableOperation[];
  readonly quarantined: number;
}

async function runPushPhase(deps: SyncCycleDeps): Promise<PushPhaseResult> {
  // Excludes `rejected` rows by construction (`listQueuedOperations`): a
  // rejected operation is retained for correction (§3.5, §9.1) and never
  // resubmitted unchanged (§9.2), so it must never reappear here.
  const queued = await listQueuedOperations(deps.executor);
  const batches = splitIntoPushBatches(queued, {
    maxOperationsPerBatch: deps.maxOperationsPerBatch,
  });

  let outcome = EMPTY_PUSH;
  const unbuildable: UnbuildableOperation[] = [];
  let quarantined = 0;

  for (const batch of batches) {
    const attempt = await pushOneBatch(deps, batch);
    outcome = mergePush(outcome, attempt.outcome);
    unbuildable.push(...attempt.unbuildable);
    quarantined += attempt.quarantined;

    if (attempt.stoppedBecause.kind !== 'completed') {
      return { outcome, stoppedBecause: attempt.stoppedBecause, unbuildable, quarantined };
    }
  }

  return { outcome, stoppedBecause: { kind: 'completed' }, unbuildable, quarantined };
}

interface BatchAttempt {
  readonly outcome: PushOutcome;
  readonly stoppedBecause: SyncStopReason;
  readonly unbuildable: readonly UnbuildableOperation[];
  readonly quarantined: number;
}

/**
 * Pushes one batch, recovering from the protocol errors that have a defined
 * recovery and isolating the ones that do not.
 *
 * `isolating` is what keeps §6.1's two rules — "retain the whole batch" and
 * "must not retry it unchanged" — from jointly stalling the queue forever.
 * A protocol error is a client bug, and a client bug is almost always in
 * *one* operation. Re-pushing the batch one operation at a time is a
 * genuinely different request, so it is not the forbidden unchanged retry;
 * the operation that still fails alone is the culprit, and quarantining
 * that one lets everything queued behind it drain.
 *
 * The alternative — stop and leave the batch in place — is what the naive
 * reading of §6.1 produces, and it means one malformed row from one app
 * version silently strands every entry a patient makes afterwards. That is
 * the same all-or-nothing failure ADR-0001 rejected, arriving one layer up.
 */
async function pushOneBatch(
  deps: SyncCycleDeps,
  batch: readonly SyncQueueEntry[],
  isolating = false,
): Promise<BatchAttempt> {
  const built = await buildPushRequest(deps.executor, batch);

  if (built.sent.length === 0) {
    return {
      outcome: EMPTY_PUSH,
      stoppedBecause: { kind: 'completed' },
      unbuildable: built.unbuildable,
      quarantined: 0,
    };
  }

  const attemptedAt = deps.now().toISOString();
  await markBatchInFlight(deps.executor, built.sent, attemptedAt);

  let response: SyncPushResponse;
  try {
    response = await deps.client.push(built.request);
  } catch (error) {
    // Fate unknown for everything in the batch (§9.3). Back on the queue,
    // untouched, before any decision about why.
    await returnBatchToQueue(deps.executor, built.sent);

    if (error instanceof MissingAccessTokenError) {
      return terminal({ kind: 'unauthenticated' }, built.unbuildable);
    }
    if (!(error instanceof ApiError)) {
      // A transport failure — no response at all. Never a rejection.
      return terminal({ kind: 'unavailable' }, built.unbuildable);
    }
    if (error.status >= 500) {
      return terminal({ kind: 'unavailable' }, built.unbuildable);
    }

    const code = protocolErrorCode(error);
    if (code === 'UNAUTHENTICATED' || error.status === 401) {
      return terminal({ kind: 'unauthenticated' }, built.unbuildable);
    }
    // Before the status check below: a 403 carrying this code is NOT an auth
    // failure, and routing it to `unauthenticated` is the loop #80 describes.
    // Nothing is quarantined and nothing is retried — the queue is fine and
    // waiting for a patient record to exist.
    if (code === 'PATIENT_NOT_PROVISIONED') {
      return terminal({ kind: 'not-provisioned' }, built.unbuildable);
    }
    if (code === 'BATCH_TOO_LARGE' || error.status === 413) {
      // §3.3's own prescribed recovery: split and re-push, preserving order.
      // A smaller request is a CHANGED request, so this is not §6.1's
      // forbidden unchanged retry. It also means this client recovers on its
      // own when an operator lowers SYNC_PUSH_MAX_OPERATIONS below what this
      // build was configured with, rather than bricking.
      if (built.sent.length === 1) {
        return quarantineSingle(deps, built.sent[0]!, code ?? 'MALFORMED_REQUEST');
      }
      return pushSplitInHalf(deps, built.sent, isolating, built.unbuildable);
    }

    // A code this build does not recognise gets RETRIED first, and is only
    // isolated once it has been seen enough times to be a real client bug
    // (§8, #80).
    //
    // Isolating immediately was wrong in one specific and reachable way: §6.1's
    // code set is closed, so a server adding a code — which §8 now records is
    // not safely additive — would make every older client treat correct entries
    // as malformed and move them toward the correction inbox. A patient would
    // be asked to fix entries that were never wrong, which §9.1's
    // never-drop-a-rejection rule cannot help with because nothing was
    // rejected.
    //
    // Retrying instead degrades that into a delay. The bound is what keeps it
    // from becoming a silent stall: a genuine client bug still reaches the
    // correction inbox, just later. `attempt_count` is already tracked per
    // operation, so this costs no new state.
    const rawCode = rawProtocolErrorCode(error);
    if (rawCode !== undefined && !isSyncProtocolErrorCode(rawCode)) {
      const everyOperationHasBeenRetriedEnough = built.sent.every(
        (entry) => entry.attemptCount >= UNKNOWN_PROTOCOL_CODE_RETRY_LIMIT,
      );
      if (!everyOperationHasBeenRetriedEnough) {
        return terminal({ kind: 'unavailable' }, built.unbuildable);
      }
    }

    // Every remaining protocol error is a client bug with no defined
    // recovery. Isolate it.
    if (built.sent.length === 1) {
      return quarantineSingle(deps, built.sent[0]!, code ?? 'MALFORMED_REQUEST');
    }
    return pushOneAtATime(deps, built.sent, built.unbuildable);
  }

  const decoded = decodePushResults(response);
  const outcome = await applyPushResults(
    deps.executor,
    built.sent,
    decoded,
    deps.now().toISOString(),
  );

  // Anything the response did not SETTLE is still `in_flight` and would
  // never be retried. §3.4 promises one result per operation, so a gap here
  // is a server that broke its contract — and an undecodable result settles
  // nothing either. Both leave the fate unknown, which §9.3 resolves the
  // same way as a dropped connection.
  const settled = new Set(
    decoded
      .filter((result) => result.kind !== 'undecodable')
      .map((result) => result.operationId as string),
  );
  const unnamed = built.sent.filter((entry) => !settled.has(entry.operationId));
  if (unnamed.length > 0) {
    await returnBatchToQueue(deps.executor, unnamed);
  }

  return {
    outcome,
    stoppedBecause: { kind: 'completed' },
    unbuildable: built.unbuildable,
    quarantined: 0,
  };

  function terminal(
    reason: SyncStopReason,
    unbuildableOps: readonly UnbuildableOperation[],
  ): BatchAttempt {
    return {
      outcome: EMPTY_PUSH,
      stoppedBecause: reason,
      unbuildable: unbuildableOps,
      quarantined: 0,
    };
  }
}

/** Halves a batch and pushes both halves in order — §3.3's recovery, which must preserve order across the split (§9.6). */
async function pushSplitInHalf(
  deps: SyncCycleDeps,
  batch: readonly SyncQueueEntry[],
  isolating: boolean,
  unbuildable: readonly UnbuildableOperation[],
): Promise<BatchAttempt> {
  const middle = Math.floor(batch.length / 2);
  return pushSequentially(
    deps,
    [batch.slice(0, middle), batch.slice(middle)],
    isolating,
    unbuildable,
  );
}

/** Re-pushes a batch one operation at a time, to find which one the server refuses. */
async function pushOneAtATime(
  deps: SyncCycleDeps,
  batch: readonly SyncQueueEntry[],
  unbuildable: readonly UnbuildableOperation[],
): Promise<BatchAttempt> {
  return pushSequentially(
    deps,
    batch.map((entry) => [entry]),
    true,
    unbuildable,
  );
}

async function pushSequentially(
  deps: SyncCycleDeps,
  batches: readonly (readonly SyncQueueEntry[])[],
  isolating: boolean,
  unbuildable: readonly UnbuildableOperation[],
): Promise<BatchAttempt> {
  let outcome = EMPTY_PUSH;
  let quarantined = 0;
  const collected = [...unbuildable];

  for (const batch of batches) {
    if (batch.length === 0) continue;
    const attempt = await pushOneBatch(deps, batch, isolating);
    outcome = mergePush(outcome, attempt.outcome);
    quarantined += attempt.quarantined;
    collected.push(...attempt.unbuildable);

    if (attempt.stoppedBecause.kind !== 'completed') {
      return {
        outcome,
        stoppedBecause: attempt.stoppedBecause,
        unbuildable: collected,
        quarantined,
      };
    }
  }

  return { outcome, stoppedBecause: { kind: 'completed' }, unbuildable: collected, quarantined };
}

/**
 * The one operation a protocol error survives down to.
 *
 * It goes to the correction inbox rather than staying on the queue, and
 * §6.4 is what makes that correct rather than a category error: a code with
 * no patient-facing copy is rendered as the generic "this entry could not be
 * saved — please check it", with the code kept for diagnostics. A protocol
 * code has no patient-facing copy by construction, so it lands in exactly
 * that bucket. The patient sees an entry that needs attention, which is
 * true, instead of an entry that silently never syncs.
 */
async function quarantineSingle(
  deps: SyncCycleDeps,
  entry: SyncQueueEntry,
  code: SyncProtocolErrorCode,
): Promise<BatchAttempt> {
  await markQuarantined(deps.executor, entry.operationId, code, deps.now().toISOString());
  return {
    outcome: EMPTY_PUSH,
    stoppedBecause: { kind: 'completed' },
    unbuildable: [],
    quarantined: 1,
  };
}

/**
 * Reads the §6.1 body — `{ "error": { "code": ... } }` — off an `ApiError`.
 *
 * Through `rejectionForCorrectionQueue()`, which is the only accessor for
 * that body: it is non-enumerable precisely so the things that carry an
 * error off-device by default cannot see it (§6.3). Reading it here is the
 * sanctioned path — the code stays on the device and is never forwarded
 * (§9.8).
 *
 * Returns `undefined` for an unrecognized code rather than throwing. §8
 * makes new protocol errors additive, so an old build must degrade rather
 * than crash.
 */
/**
 * The `error.code` string the server sent, whatever it was.
 *
 * Separate from `protocolErrorCode` because that one narrows to §6.1's set and
 * so answers `undefined` for **two different situations**: a body carrying no
 * code at all, and a body carrying a code this build has never heard of. Those
 * need opposite handling — the first is a malformed response, the second is a
 * newer server — and collapsing them is why the retry-before-isolate rule could
 * not be expressed against `protocolErrorCode` alone (#80).
 */
function rawProtocolErrorCode(error: ApiError): string | undefined {
  const body = error.rejectionForCorrectionQueue();
  if (typeof body !== 'object' || body === null) return undefined;
  const wrapper = (body as { error?: unknown }).error;
  if (typeof wrapper !== 'object' || wrapper === null) return undefined;
  const code = (wrapper as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function protocolErrorCode(error: ApiError): SyncProtocolErrorCode | undefined {
  const body = error.rejectionForCorrectionQueue();
  if (typeof body !== 'object' || body === null) return undefined;
  const wrapper = (body as { error?: unknown }).error;
  if (typeof wrapper !== 'object' || wrapper === null) return undefined;
  const code = (wrapper as { code?: unknown }).code;
  return isSyncProtocolErrorCode(code) ? code : undefined;
}

interface DeltaPhaseResult {
  readonly outcome: DeltaOutcome;
  readonly stoppedBecause: SyncStopReason;
}

/**
 * Pulls pages until `hasMore` is false, persisting the cursor after each
 * (`applyDeltaPage`).
 *
 * A `CURSOR_TOO_OLD` is reported here, never acted on here. §5.4's recovery
 * discards local rows, and a background worker is the wrong place to do that
 * silently: the wipe is indistinguishable to a patient from their diary
 * emptying itself. So this stops the cycle and names the reason; the recovery
 * itself lives in `db/staleCursorRecovery.ts` and is invoked by a screen
 * (`useSyncStatus().recoverStaleCursor`) once the patient has been told what
 * will happen. That recovery keeps queued-but-unpushed entries, which a
 * literal reading of §5.4 would destroy and §9.1 forbids.
 */
async function runDeltaPhase(deps: SyncCycleDeps): Promise<DeltaPhaseResult> {
  let upserts = 0;
  let tombstones = 0;
  let pages = 0;
  let skippedAsStale = 0;
  let undecodable = 0;
  let unsupportedEntity = 0;

  for (;;) {
    const since = await getCursor(deps.executor);

    let page: SyncDeltaResponse;
    try {
      page = await deps.client.delta({
        since,
        ...(deps.deltaPageSize === undefined ? {} : { limit: deps.deltaPageSize }),
      });
    } catch (error) {
      const outcome: DeltaOutcome = {
        upserts,
        tombstones,
        pages,
        skippedAsStale,
        undecodable,
        unsupportedEntity,
      };
      if (error instanceof MissingAccessTokenError) {
        return { outcome, stoppedBecause: { kind: 'unauthenticated' } };
      }
      if (!(error instanceof ApiError) || error.status >= 500) {
        return { outcome, stoppedBecause: { kind: 'unavailable' } };
      }
      if (error.status === 401) {
        return { outcome, stoppedBecause: { kind: 'unauthenticated' } };
      }
      const code = protocolErrorCode(error);
      if (code === 'CURSOR_TOO_OLD' || error.status === 409) {
        return { outcome, stoppedBecause: { kind: 'cursor-too-old' } };
      }
      return {
        outcome,
        stoppedBecause: { kind: 'protocol-error', code: code ?? 'MALFORMED_REQUEST' },
      };
    }

    const decodedPage = decodeDeltaPage(page);
    const applied = await applyDeltaPage(deps.executor, decodedPage, deps.now().toISOString());
    upserts += applied.upserts;
    tombstones += applied.tombstones;
    skippedAsStale += applied.skippedAsStale;
    undecodable += applied.undecodable;
    unsupportedEntity += applied.unsupportedEntity;
    pages += 1;

    if (!decodedPage.hasMore) {
      return {
        outcome: { upserts, tombstones, pages, skippedAsStale, undecodable, unsupportedEntity },
        stoppedBecause: { kind: 'completed' },
      };
    }

    // A server that reports `hasMore: true` without advancing its cursor
    // would spin this loop forever against an unchanged `since`. Nothing in
    // §5 forbids it explicitly because a correct server cannot produce it;
    // this client still must not hang on one.
    if (decodedPage.cursor === since) {
      return {
        outcome: { upserts, tombstones, pages, skippedAsStale, undecodable, unsupportedEntity },
        stoppedBecause: { kind: 'unavailable' },
      };
    }
  }
}

function mergePush(a: PushOutcome, b: PushOutcome): PushOutcome {
  return {
    accepted: a.accepted + b.accepted,
    superseded: a.superseded + b.superseded,
    rejected: a.rejected + b.rejected,
    unrecognized: a.unrecognized + b.unrecognized,
  };
}
