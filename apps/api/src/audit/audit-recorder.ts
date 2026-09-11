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

import type { Request } from 'express';

import type { AuditContext } from './audit-context';

/**
 * A staged audit entry — everything `AuditContext` carries except
 * `correlationId`, which `AuditInterceptor` fills in itself from the
 * request (`logging/request-id.ts`) rather than trusting a handler to copy
 * it correctly on every call.
 */
export type StagedAuditEntry = Omit<AuditContext, 'correlationId'> & {
  /**
   * `true` when the handler already persisted this audit row itself, inside
   * the same database transaction as the PHI write it describes
   * (`AuditService.record(context, tx)`).
   *
   * Added at P2.S1a, the first real PHI write path, to close the gap P1.S5
   * documented and could not act on: `AuditInterceptor` runs *after* the
   * handler's observable emits, so a plain staged entry is always a second
   * transaction, committed after the PHI row is already durable. Between the
   * two commits, a crash, a connection reset or a disk-full leaves a
   * clinical row with no audit row — the one outcome this whole apparatus
   * exists to prevent, and one that is undetectable afterwards because the
   * PHI row looks perfectly legitimate.
   *
   * A handler that owns its own `$transaction` therefore records inside it
   * and stages the entry with this flag. The interceptor skips persisting it
   * (persisting again would duplicate the row in an append-only table with
   * no DELETE grant to fix it) but still **counts** it toward the
   * "@Audited() route staged nothing" trip-wire — which is the whole point:
   * moving the write into the transaction must not cost the coverage check
   * that catches a PHI write with no audit row at all.
   */
  readonly persisted?: true;

  /**
   * The `audit_events.id` returned by the `AuditService.record()` call that
   * wrote this entry. Present exactly when `persisted` is — it is what makes
   * that flag a fact rather than an assertion. See `stageCommittedAuditEntry()`.
   */
  readonly auditEventId?: string;
};

/**
 * Request-object staging, the same pattern this codebase already uses for
 * "what does this request carry" (`auth/patient-actor.ts`'s `request.patient`,
 * `admin/admin-actor.ts`'s `request.admin`, `logging/request-id.ts`'s
 * `request.id`) — a single module-augmentation declaration plus typed
 * accessor functions, rather than a request-scoped NestJS provider. Chosen
 * over a `Scope.REQUEST` injectable specifically to avoid `AuditInterceptor`
 * itself becoming request-scoped (Nest promotes any provider that depends on
 * a request-scoped one), which would apply to every route in the
 * application, not just audited ones.
 *
 * A PHI-writing handler calls `stageAuditEntry()` once per entity it wrote —
 * a batch endpoint like sync push (P2.S1b) calls it once per accepted
 * operation — before returning. `AuditInterceptor` calls `drainAuditEntries()`
 * exactly once, after the handler's observable emits, and persists whatever
 * was staged.
 */
declare module 'express-serve-static-core' {
  interface Request {
    auditEntries?: StagedAuditEntry[];
  }
}

/** Stages one audit entry for `AuditInterceptor` to persist once the current handler completes. */
export function stageAuditEntry(request: Request, entry: StagedAuditEntry): void {
  (request.auditEntries ??= []).push(entry);
}

/**
 * Declares an audit row this handler **already committed**, inside the same
 * transaction as the PHI write it describes.
 *
 * Call this instead of `stageAuditEntry()` — never as well as — from a
 * handler that passed a `Prisma.TransactionClient` to
 * `AuditService.record()`. The interceptor will not write it a second time,
 * and the route still satisfies the `@Audited()` coverage check. See
 * `StagedAuditEntry.persisted` for why this exists.
 *
 * **`auditEventId` is the proof, and it is required (P2.S1a review).** The
 * first version of this function took the caller's word for it, which turned
 * P1.S5's guarantee — "an `@Audited()` route *produced* an audit row",
 * because the interceptor wrote it — into "an `@Audited()` route *claimed*
 * one." A handler that called this and forgot `record(ctx, tx)` passed every
 * trip-wire while writing PHI with no audit row: the route is decorated,
 * entries were staged so `persistStagedEntries` does not throw, and the
 * interceptor skips them all because `persisted` is set. Before the flag
 * existed, that same bug was a loud 500.
 *
 * Requiring the id `AuditService.record()` returns closes it structurally:
 * there is no way to produce one without having called `record()`. This
 * matters most for P2.S1b, where one route applies many operations in a loop
 * and a dropped call on one branch would otherwise be silent.
 */
export function stageCommittedAuditEntry(
  request: Request,
  entry: Omit<AuditContext, 'correlationId'>,
  auditEventId: string,
): void {
  if (typeof auditEventId !== 'string' || auditEventId.length === 0) {
    throw new Error(
      'stageCommittedAuditEntry() requires the id returned by AuditService.record(). ' +
        'An empty id means the audit row was not actually written, and staging it as ' +
        'committed would defeat the @Audited() coverage check.',
    );
  }
  (request.auditEntries ??= []).push({ ...entry, persisted: true, auditEventId });
}

/**
 * Returns every entry staged so far on this request, and clears the list.
 * Draining (not merely reading) matters for correctness under retries within
 * a single request lifecycle — nothing in this app does that yet, but a
 * "peek" API would silently double-record the day something does.
 */
export function drainAuditEntries(request: Request): StagedAuditEntry[] {
  const entries = request.auditEntries ?? [];
  request.auditEntries = [];
  return entries;
}
