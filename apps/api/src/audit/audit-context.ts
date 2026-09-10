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
 * The shape every PHI-mutation audit record is built from (SRS §5.2,
 * ADR-0011). This is the type P1.S5's exit criteria mean by "AuditContext":
 * a plain, request-independent value object that both
 *
 *   1. a request-scoped write stages via `stageAuditEntry()`
 *      (`audit-recorder.ts`) for `AuditInterceptor` to persist after the
 *      handler completes, and
 *   2. a write with no HTTP request of its own — the losing side of a
 *      last-write-wins conflict (ADR-0001), or a sync-applied write P2.S1b
 *      resolves outside of any single inbound request — constructs directly
 *      and hands to `AuditService.record()`.
 *
 * Neither caller is more "special" than the other: `AuditService.record()`
 * is the single write path to `audit_events`, and `AuditInterceptor` is
 * simply its first, HTTP-triggered caller. This is what makes the
 * conflict-loser path (which P2 builds) structural rather than something a
 * future author has to remember to wire up themselves — the type they must
 * produce already exists, and the only function capable of writing an audit
 * row already requires it.
 *
 * Transactional callers (B2, P1.S5 review response): a handler that owns
 * its own `$transaction` — P2.S1a's observation write, P2.S1b's
 * sync-applied write and conflict-loser handling — should pass that same
 * `Prisma.TransactionClient` as `AuditService.record()`'s second argument
 * (`tx`) rather than calling `record(context)` alone. Without it, the PHI
 * write and its audit row are two separate transactions: the PHI write can
 * commit while the audit write fails, landing an unaudited row with no way
 * to roll either back. Passing `tx` makes both writes commit or roll back
 * together. `AuditInterceptor` itself still calls `record()` without `tx`
 * this sprint — its timing (after the handler's observable emits, so
 * outside the handler's own transaction if it has one) is unchanged; `tx`
 * is made available for a caller in the position to use it, not retrofitted
 * onto the interceptor.
 */
export type AuditActorType = 'PATIENT' | 'ADMIN' | 'SYSTEM';

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

export interface AuditContext {
  /**
   * Never inferred, never defaulted to `'SYSTEM'` on a missing value — see
   * `AuditService.record()`'s validation. A null or guessed actor is exactly
   * the failure mode the P1.S1 accessors (`getPatientActor`/`getAdminActor`)
   * were built to make impossible to reach silently; this type carries that
   * same discipline into the audit row itself.
   */
  readonly actorType: AuditActorType;
  /** The verified JWT subject — see `Patient.oidcSubject`'s and `AuditEvent.actorId`'s own doc comments for why this is the only claim ever carried onto an audit row. */
  readonly actorId: string;
  readonly action: AuditAction;
  /**
   * A short, stable, greppable label for what kind of thing changed (e.g.
   * `'observation'`, `'audit_stub_widget'`) — free text, matching
   * `AuditEvent.entityType`'s own column comment, because the set of
   * entities this system audits grows every sprint without a schema
   * migration.
   */
  readonly entityType: string;
  readonly entityId: string;
  /**
   * e.g. `'direct_write' | 'sync_applied' | 'sync_conflict_loser' |
   * 'admin_config_change'` — see `AuditEvent.reasonCode`'s column comment.
   * ADR-0001 requires `'sync_applied'` and `'sync_conflict_loser'` to exist
   * once P1.S5/P2.S1b land; this field is how a caller supplies either.
   */
  readonly reasonCode?: string;
  /** The full prior state, or `undefined` for a `CREATE` (there is no prior state). Never the offending value alone — the whole entity, so an auditor can reconstruct exactly what changed. */
  readonly beforeValue?: unknown;
  /** The full new state, or `undefined` for a `DELETE`. */
  readonly afterValue?: unknown;
  /**
   * The request correlation id (`logging/request-id.ts`), threaded through
   * so an auditor can reconstruct which resolution belonged to which
   * request — load-bearing for sync (P2), which is a batch endpoint: one
   * push produces N audit rows, and a conflict loser produces a row with no
   * request of its own (it still carries the correlation id of the push
   * that produced it, supplied by the caller, not derived from a request
   * object it doesn't have).
   *
   * Persisted to the indexed `audit_events.correlation_id` column. It was
   * not always: P1.S5 flagged the missing column, could not change
   * `prisma/`, and nested this value inside `beforeValue`/`afterValue`
   * instead. Migration `20260906203344_add_audit_correlation_id` added the
   * column, and P2.S1a — the first sprint writing real clinical rows — is
   * what started writing to it, before the wrapped shape could become
   * permanent in a table with no UPDATE grant (ADR-0011).
   */
  readonly correlationId?: string;
}
