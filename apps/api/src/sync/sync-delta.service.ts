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

import { Inject, Injectable } from '@nestjs/common';
import {
  syncDeltaTombstone,
  syncDeltaUpsert,
  SYNC_ENTITY_TYPE,
  toEntityId,
  toServerSequence,
  type SyncDeltaChange,
  type SyncDeltaResponse,
} from '@ostomy/core/sync';

import { Prisma, type Meal, type Observation } from '../generated/prisma/client';
import { SecurityLogService } from '../logging/security-log.service';
import { PrismaService } from '../prisma/prisma.service';
import { toObservationResource } from '../observations/observation-payload';
import { toMealResource } from '../meals/meal-payload';
import { patientNotProvisioned } from '../observations/observation-rejection';
import type { SyncDeltaQueryParsed } from './sync-delta.pipe';

/**
 * Serves `GET /api/v1/sync/delta` (`docs/sync-contract.md` §5).
 *
 * ## The cursor guarantee, and why a plain `ORDER BY server_sequence` breaks it
 *
 * §5.3 states the invariant: *if a client's cursor is `C`, the client has
 * been shown every change for that patient with server sequence ≤ `C`.* That
 * is the entire reason ADR-0001 chose a monotonic sequence over an
 * `updated_at` timestamp, and §5.3 is explicit that **it does not hold for
 * free.**
 *
 * PostgreSQL sequences are non-transactional: `nextval` is consumed before
 * commit, and transactions commit in an order that need not match the values
 * they took. A reader can see sequence 48214 committed while 48213 is still
 * in flight. A client handed `cursor: "48214"` never asks for 48213 again,
 * and that row is silently, permanently invisible to that device — no error,
 * no retry, and no way for either side to detect it afterwards.
 *
 * This was reproduced against real PostgreSQL before the fix was written, and
 * `sync.integration.spec.ts` keeps reproducing it: two concurrent writes
 * committed out of order, where the naive query returns only the later row.
 *
 * ## The mechanism
 *
 * §5.3's option 1 — **withhold the in-flight window.** A row is served only
 * when its assigning transaction is known to have completed: every
 * transaction older than the current snapshot's xmin has finished, so no row
 * it wrote can still be pending, and no *lower* sequence can still arrive
 * behind one that is served.
 *
 * Expressed with `age()` on both sides rather than as a numeric `<`, and that
 * is not cosmetic. `xmin` is an `xid` — 32 bits, wrapping, no epoch — while
 * `pg_snapshot_xmin()` returns an `xid8`, which is epoch-extended to 64 bits.
 * The first version of this predicate cast both through `text` to `bigint`,
 * comparing two different domains. It agrees in epoch 0, which is why every
 * test passed. Past the cluster's first ~4.3 billion transactions the
 * snapshot value exceeds 2^32 while no row's `xmin` can, the predicate
 * becomes unconditionally true, and this query silently degrades to exactly
 * the naive `ORDER BY server_sequence` it exists to replace — **failing
 * open**, with no error and nothing that would notice. `age()` does modular
 * comparison in the 32-bit domain for both operands, which is what makes it
 * wraparound-safe.
 *
 * Chosen over §5.3's option 2 (per-patient counter with `SELECT … FOR
 * UPDATE`) because it needs no schema change and keeps the global
 * `sync_sequence` and its triggers, which P1.S3 already built and tested.
 * Option 3 (bounded lag) is ruled out by §5.3 itself: it narrows the race
 * rather than closing it, and fails exactly under the load that makes the
 * race likely.
 *
 * ## Why one snapshot, and why the two-query split was not enough
 *
 * The predicate above is necessary and was not sufficient. The first version
 * of this method ran the `xmin` filter in one statement (ids only) and
 * re-fetched the rows in a second, unsynchronized statement — taking the
 * cursor from the second. Both reviewers found the same hole independently.
 *
 * `assign_sync_sequence()` is a `BEFORE INSERT **OR UPDATE**` trigger, so any
 * update re-stamps `server_sequence`. Under READ COMMITTED each statement
 * takes its own snapshot, so: a patient has A(10), B(11), C(12); a pull with
 * `limit=2` selects ids [A, B] and sets `hasMore`; the patient's second
 * device updates B, which becomes sequence 20 and commits; the row re-fetch
 * returns A(10) and B(20); the cursor is taken from the last row and becomes
 * **20**. The client asks for `since=20` and **C(12) is never served to that
 * device again** — the same silent, permanent invisibility, arriving through
 * the read path instead of the write path.
 *
 * So both reads run inside one `RepeatableRead` transaction. That is a
 * correctness requirement, not a performance choice: dropping the isolation
 * level, or moving either query outside the transaction, reopens the hole.
 * `sync.integration.spec.ts` races a committed update against a delta pull
 * specifically to catch that, and a sibling test pins the isolation
 * behaviour itself so a future reader can see what the transaction is for.
 *
 * **Two costs a future reader should know about.** A just-written row may
 * need one more poll to appear — harmless, because §9.5 forbids a client
 * confirming a save from a network response anyway. And
 * `pg_snapshot_xmin` is held back by *any* long-running transaction in the
 * database, not only writers to these tables: a long analytics query or a
 * bulk `packages/seed` load stalls delta for everyone until it finishes.
 * That is a liveness cost, never a correctness one — rows are delayed, never
 * skipped — but it is the thing to look at first if delta ever appears to
 * stop advancing.
 */
@Injectable()
export class SyncDeltaService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(SecurityLogService) private readonly securityLog: SecurityLogService,
  ) {}

  async delta(
    actorSubject: string,
    query: SyncDeltaQueryParsed,
    requestId: string | undefined,
  ): Promise<SyncDeltaResponse> {
    // `PatientActor.id` is the OIDC subject, not the patients row UUID.
    // Resolving it here rather than taking a patient id from the controller
    // keeps the (patient, id) scope one lookup away from the token and gives
    // the caller no way to pass in something else.
    const patient = await this.prisma.patient.findUnique({
      where: { oidcSubject: actorSubject },
      select: { id: true, profile: { select: { deletedAt: true } } },
    });
    if (!patient?.profile || patient.profile.deletedAt !== null) {
      throw patientNotProvisioned();
    }
    const patientId = patient.id;

    // §2. `since=0` returns the patient's entire clinical history in pages —
    // legitimate exactly at install and reinstall, and also what a stolen
    // token is worth. Recorded so the two can be told apart afterwards by
    // frequency and timing, which is the determination the
    // breach-notification clock runs on. Deliberately not `audit_events`: a
    // read is not an SRS §5.2 event.
    if (query.since === 0n) {
      this.securityLog.fullHistoryPull({
        actorSubject,
        patientId,
        requestId,
        limit: query.limit,
      });
    }

    // BOTH reads take ONE snapshot. This is the whole point of the
    // transaction and it is not an optimisation — see the class comment's
    // "Why one snapshot" section. Read-only, so it costs a connection for
    // the duration of two indexed queries and nothing else.
    const { page, hasMore } = await this.prisma.$transaction(
      async (tx) => {
        // Two steps on purpose. The visibility predicate needs the `xmin`
        // system column, which Prisma's typed API cannot express, so it runs
        // as raw SQL — but only to decide WHICH rows are servable. The rows
        // themselves come back through the typed client, so nothing
        // downstream is hand-mapped from snake_case and
        // `toObservationResource` keeps its real argument type.
        //
        // One extra id, to decide `hasMore` without a second count query.
        //
        // A UNION across every synced entity table, which is what the shared
        // `sync_sequence` was created for: one cursor is comparable across
        // tables, so a page can interleave entity types in true write order.
        // Paging each table separately would make the cursor mean something
        // different per type, and §5.3's invariant is stated over the cursor.
        //
        // The visibility predicate is repeated per branch rather than applied
        // to the union, deliberately — `xmin` is a per-row system column and
        // has no meaning on a union's output, so hoisting it would silently
        // stop withholding the in-flight window (ADR-0013) for every type.
        const visible = await tx.$queryRaw<{ id: string; entity_type: string }[]>`
          SELECT id, 'Observation' AS entity_type, server_sequence
          FROM observations
          WHERE patient_id = ${patientId}::uuid
            AND server_sequence > ${query.since}
            AND age(xmin) > age(pg_snapshot_xmin(pg_current_snapshot())::text::xid)
          UNION ALL
          SELECT id, 'Meal' AS entity_type, server_sequence
          FROM meals
          WHERE patient_id = ${patientId}::uuid
            AND server_sequence > ${query.since}
            AND age(xmin) > age(pg_snapshot_xmin(pg_current_snapshot())::text::xid)
          ORDER BY server_sequence ASC
          LIMIT ${query.limit + 1}
        `;

        const more = visible.length > query.limit;
        const pageRefs = more ? visible.slice(0, query.limit) : visible;

        const observationIds = pageRefs
          .filter((ref) => ref.entity_type === 'Observation')
          .map((ref) => ref.id);
        const mealIds = pageRefs.filter((ref) => ref.entity_type === 'Meal').map((ref) => ref.id);

        // Re-scoped to the patient here as well as above. Belt and braces at
        // a seam where a future edit could plausibly drop one of the two, and
        // §2 admits no exception: every entity lookup is by (patient, id)
        // together.
        const [observations, meals] = await Promise.all([
          observationIds.length === 0
            ? Promise.resolve([])
            : tx.observation.findMany({
                where: { id: { in: observationIds }, patientId },
                orderBy: { serverSequence: 'asc' },
              }),
          mealIds.length === 0
            ? Promise.resolve([])
            : tx.meal.findMany({
                where: { id: { in: mealIds }, patientId },
                orderBy: { serverSequence: 'asc' },
              }),
        ]);

        // Re-merged into ONE sequence-ordered page. The two typed reads above
        // each return their own table in order; interleaving them by
        // `serverSequence` is what makes the page match the order the union
        // chose, and therefore what makes `nextCursor` — which reads the LAST
        // element — correct.
        const page: DeltaRow[] = [
          ...observations.map((row): DeltaRow => ({ kind: 'observation', row })),
          ...meals.map((row): DeltaRow => ({ kind: 'meal', row })),
        ].sort((a, b) => (a.row.serverSequence < b.row.serverSequence ? -1 : 1));

        return { page, hasMore: more };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const changes = page.map(toChange);

    return {
      changes,
      cursor: toServerSequence(nextCursor(page, query.since).toString()),
      // §5.2: `hasMore` is about THIS PAGE, not the server's high-water mark.
      // Defining it as `max(serverSequence) > cursor` is the natural mistake
      // and produces `changes: []` with `hasMore: true` under the visibility
      // filter above, which withholds not-yet-committed rows — the client
      // then spins in a tight loop against the API. It is false whenever
      // `changes` is empty, which falls out of deriving it from the page.
      hasMore,
    };
  }
}

/**
 * §5.1: a `since` higher than anything the server holds returns
 * `changes: []`, `hasMore: false`, and **`cursor` echoing `since`
 * unchanged**.
 *
 * The two tempting alternatives are both wrong. Returning the server's
 * maximum moves a client's cursor *backwards* into rows it has already
 * applied; returning `"0"` silently re-downloads the patient's entire
 * history over cellular. Reachable through a device restore, a `dev-reset`,
 * or a database restore from backup.
 */
/**
 * One row of a delta page, tagged with which table it came from.
 *
 * A discriminated union rather than a bare `Observation | Meal`: the two
 * share `id`, `serverSequence`, `clientUpdatedAt` and `deletedAt`, so a
 * structural check would compile for the wrong one and `toChange` would
 * project a meal as an observation. The tag is what makes the dispatch
 * exhaustive.
 */
export type DeltaRow =
  | { readonly kind: 'observation'; readonly row: Observation }
  | { readonly kind: 'meal'; readonly row: Meal };

function nextCursor(page: readonly DeltaRow[], since: bigint): bigint {
  const last = page[page.length - 1];
  return last === undefined ? since : last.row.serverSequence;
}

/**
 * Projects a row into a wire change through `packages/core`'s constructors.
 *
 * **Never `{ ...row, deleted: true }`.** That compiles — TypeScript's
 * excess-property check does not apply to spread properties — and ships the
 * clinical values of a deleted entry to every device on the account, where
 * they land in `expo-sqlite`. §5.2 and §6.3 both forbid it, and the
 * constructors exist precisely so the wrong thing cannot be written from a
 * call site.
 */
function toChange(entry: DeltaRow): SyncDeltaChange {
  return entry.kind === 'meal' ? toMealChange(entry.row) : toObservationChange(entry.row);
}

/**
 * A `Meal` change (§7.4). Same tombstone rule, same constructors, same
 * never-spread discipline as an observation's — the differences are the
 * payload fields and the absence of `resourceType`.
 */
function toMealChange(row: Meal): SyncDeltaChange {
  const entityId = toEntityId(row.id);
  const serverSequence = toServerSequence(row.serverSequence.toString());
  const clientUpdatedAt = row.clientUpdatedAt.toISOString();

  if (row.deletedAt !== null) {
    return syncDeltaTombstone({
      entityType: SYNC_ENTITY_TYPE.MEAL,
      entityId,
      serverSequence,
      clientUpdatedAt,
    });
  }

  const resource = toMealResource(row);
  return syncDeltaUpsert({
    entityType: SYNC_ENTITY_TYPE.MEAL,
    entityId,
    serverSequence,
    clientUpdatedAt,
    // Named field by field, never spread from `resource` — same reason as
    // the observation branch below.
    payload: {
      id: entityId,
      description: resource.description,
      size: resource.size,
      tagCodes: resource.tagCodes,
      effectiveDateTime: resource.effectiveDateTime,
      enteredTimezone: resource.enteredTimezone,
    },
  });
}

function toObservationChange(row: Observation): SyncDeltaChange {
  const entityId = toEntityId(row.id);
  const serverSequence = toServerSequence(row.serverSequence.toString());
  // §5.2: a tombstone's `clientUpdatedAt` is the client timestamp of the
  // operation that DELETED the row, not a server receipt time. A device
  // holding an unpushed local edit to an entity it has just been told is
  // deleted resolves that itself, by the same last-write-wins rule §4
  // applies server-side — and it cannot do that against a clock it does not
  // share. The server's own `deletedAt` is bookkeeping and never crosses
  // the wire.
  const clientUpdatedAt = row.clientUpdatedAt.toISOString();

  if (row.deletedAt !== null) {
    // No payload at all — not an empty one. The receiving device needs the
    // entity id to remove its local row and nothing else; the minimum-
    // necessary rule applies to a protocol as much as to a screen.
    return syncDeltaTombstone({
      entityType: SYNC_ENTITY_TYPE.OBSERVATION,
      entityId,
      serverSequence,
      clientUpdatedAt,
    });
  }

  // Named field by field rather than spread from `toObservationResource(row)`.
  // The two types describe the same wire object but are not the same type —
  // `packages/core`'s `id` is a branded `EntityId` while the API's resource
  // type uses a plain string — and spreading to bridge that would also carry
  // any field the API's type gains later, silently, which is the §6.3 hazard
  // in its exact documented form.
  //
  // (That the two types exist separately at all is worth revisiting: the
  // contract says both endpoints exchange one payload shape. Left alone here
  // because unifying them is a `packages/core` ownership question under
  // ADR-0007, not a sync-handler one.)
  const resource = toObservationResource(row);
  return syncDeltaUpsert({
    entityType: SYNC_ENTITY_TYPE.OBSERVATION,
    entityId,
    serverSequence,
    clientUpdatedAt,
    payload: {
      resourceType: 'Observation',
      id: entityId,
      status: resource.status,
      code: resource.code,
      // Spread-or-omit, never `valueQuantity: undefined`. Under
      // `exactOptionalPropertyTypes` those are different types, and the
      // distinction is the clinical one: a delta that carries the key with
      // no value invites a consumer to read it as an empty measurement,
      // where an absent key says the entry recorded a colour instead
      // (AC 12.1 AC2).
      ...(resource.valueQuantity === undefined ? {} : { valueQuantity: resource.valueQuantity }),
      effectiveDateTime: resource.effectiveDateTime,
      method: resource.method,
      enteredMeasurementSystem: resource.enteredMeasurementSystem,
      enteredTimezone: resource.enteredTimezone,
    },
  });
}
