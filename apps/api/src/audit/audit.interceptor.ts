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

import {
  Inject,
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, type Observable } from 'rxjs';
import { catchError, concatMap, map } from 'rxjs/operators';

import { getRequestId } from '../logging/request-id';
import { AUDITED_KEY, type AuditedMetadata } from './audited.decorator';
import { AuditService } from './audit.service';
import { drainAuditEntries, type StagedAuditEntry } from './audit-recorder';

/**
 * The one enhancer in this application registered globally (`APP_INTERCEPTOR`,
 * see `audit-interceptor.module.ts`) rather than per-controller — see
 * `README.md`'s note on why "no global enhancer" is a convention scoped to
 * guards, not to every enhancer. Per-controller opt-in is exactly how a
 * sync-applied write ends up unaudited; a global interceptor examines every
 * route and only does something on the ones a handler author actually
 * marked `@Audited()`.
 *
 * Deliberately does not persist eagerly inside a `tap()` side effect: this
 * uses `concatMap` so the HTTP response **waits** for the audit write to
 * complete (and fails, as a 500, if it doesn't) rather than the response
 * going out first and the audit persistence racing it in the background.
 * The alternative — `tap()` firing an unawaited async persist — would let a
 * client see success while the audit row might still fail to land, which is
 * exactly the silent-gap shape SRS §5.2 exists to close.
 *
 * B1 (P1.S5 review response): `concatMap`'s project function only runs on
 * the success (`next`) channel — it is never invoked when `next.handle()`
 * (the handler itself) throws. Before this fix, that meant a handler which
 * staged N entries and then threw (P2.S1b's sync push applying operations
 * 1..N, each committed, then failing on N+1 or during response
 * serialization is the concrete, imminent case) lost every staged entry:
 * `drainAuditEntries()` never ran, nothing was persisted, and no log or
 * error even mentioned audit. N PHI writes stood with zero audit rows —
 * exactly the gap this sprint exists to close. `catchError`, below, is what
 * closes it: it runs on both the handler's own error and any error
 * `persistStagedEntries` itself throws (including the "staged nothing"
 * case), drains and best-effort persists whatever is still staged, and only
 * then rethrows the original error so the response still fails.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  // Explicit `@Inject()` on both params — see `AuditService`'s constructor
  // comment for why implicit type-based injection is not safe under this
  // workspace's Vitest (esbuild) transform.
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuditService) private readonly auditService: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const auditedMetadata = this.reflector.getAllAndOverride<AuditedMetadata | undefined>(
      AUDITED_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!auditedMetadata) {
      return next.handle();
    }
    const allowEmpty =
      typeof auditedMetadata === 'object' ? auditedMetadata.allowEmpty === true : false;

    const request = context.switchToHttp().getRequest<Request>();
    const correlationId = getRequestId(request);

    return next.handle().pipe(
      concatMap((responseBody: unknown) =>
        from(this.persistStagedEntries(request, correlationId, allowEmpty)).pipe(
          map(() => responseBody),
        ),
      ),
      // B1: catches BOTH the handler's own thrown error (which never
      // reaches `concatMap`'s project function above — RxJS propagates a
      // source error straight downstream) and any error thrown from
      // within `persistStagedEntries` itself (including a genuine
      // `AuditService.record()` failure on the success path, where
      // `drainAuditEntries()` has already emptied the request — see
      // `persistOnError`'s own comment for why that case is safe to
      // re-drain).
      catchError((error: unknown) => from(this.persistOnError(request, correlationId, error))),
    );
  }

  /**
   * Throws — converting the response into a 500 via Nest's ordinary
   * exception handling — when a route marked `@Audited()` completes having
   * staged nothing, unless the route opted out with `@Audited({ allowEmpty:
   * true })` (S2). This is what makes the sprint's central claim testable:
   * remove this interceptor from the module graph, and a PHI write that
   * forgets `stageAuditEntry()` (or one that never had the interceptor
   * enforcing it in the first place) succeeds with no audit row at all,
   * silently. With the interceptor present, the same missing-stage bug
   * fails loudly instead of shipping unaudited.
   *
   * This proves only that *at least one* entry was staged for the route —
   * not that every entity the handler touched was. A batch endpoint that
   * stages one entry out of twenty operations applied satisfies this check
   * while nineteen writes go unaudited; closing that gap needs a
   * per-entity, database-level guarantee (B2's transactional `record()` is
   * a step toward it), not a per-route trip-wire. See `README.md`'s "Audit
   * coverage" section for the corrected claim.
   */
  private async persistStagedEntries(
    request: Request,
    correlationId: string | undefined,
    allowEmpty: boolean,
  ): Promise<void> {
    const entries = drainAuditEntries(request);
    if (entries.length === 0) {
      if (allowEmpty) {
        return;
      }
      throw new Error(
        'AuditInterceptor: route is marked @Audited() but completed with no staged audit entries. ' +
          'Every PHI write must call stageAuditEntry() (audit-recorder.ts) before returning, or the ' +
          'route must declare @Audited({ allowEmpty: true }) if staging nothing is a legitimate outcome.',
      );
    }
    for (const entry of entries) {
      // Conditional spread, not `correlationId` assigned directly: with
      // `exactOptionalPropertyTypes`, `AuditContext.correlationId` (an
      // optional key) must be omitted rather than explicitly set to
      // `undefined` when `getRequestId()` found none.
      await this.auditService.record({
        ...entry,
        ...(correlationId !== undefined ? { correlationId } : {}),
      });
    }
  }

  /**
   * B1's error-channel branch. Drains whatever is still staged on the
   * request — non-empty when the handler itself threw before
   * `persistStagedEntries` ever ran (the entries it staged before throwing
   * are exactly what would otherwise be lost); empty when the error instead
   * came from `persistStagedEntries` on the success path, since that
   * function already drained the list before it could fail, so re-draining
   * here is a safe no-op rather than a double-persist.
   *
   * Every staged entry is persisted best-effort — a failure persisting one
   * entry does not stop the rest from being attempted — and any persist
   * failure is logged loudly (never at the level of a swallowed warning)
   * with only non-PHI identifying fields (`entityType`, `entityId`,
   * `action`, `actorId`, `reasonCode`, and the sanitized `AuditPersistenceError`
   * B3 guarantees never carries the original message or error object — see
   * `audit.service.ts`). The ORIGINAL handler error is always what gets
   * rethrown, never a persistence failure, so the client still sees the
   * failure that actually happened.
   */
  private async persistOnError(
    request: Request,
    correlationId: string | undefined,
    error: unknown,
  ): Promise<never> {
    const entries = drainAuditEntries(request);
    for (const entry of entries) {
      await this.tryPersistOnError(entry, correlationId);
    }
    throw error;
  }

  private async tryPersistOnError(
    entry: StagedAuditEntry,
    correlationId: string | undefined,
  ): Promise<void> {
    try {
      await this.auditService.record({
        ...entry,
        ...(correlationId !== undefined ? { correlationId } : {}),
      });
    } catch (persistError) {
      this.logger.error({
        msg:
          'AuditInterceptor: failed to persist a staged audit entry after the handler threw — ' +
          'a PHI write may have already committed with zero audit rows for this entity. ' +
          'Manual investigation required.',
        entityType: entry.entityType,
        entityId: entry.entityId,
        action: entry.action,
        actorId: entry.actorId,
        reasonCode: entry.reasonCode,
        persistErrorName: persistError instanceof Error ? persistError.name : undefined,
        persistErrorMessage: persistError instanceof Error ? persistError.message : undefined,
      });
    }
  }
}
