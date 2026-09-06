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
export type StagedAuditEntry = Omit<AuditContext, 'correlationId'>;

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
