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
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { from, type Observable } from 'rxjs';
import { concatMap, map } from 'rxjs/operators';

import { getRequestId } from '../logging/request-id';
import { AUDITED_KEY } from './audited.decorator';
import { AuditService } from './audit.service';
import { drainAuditEntries } from './audit-recorder';

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
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
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

    const isAudited = this.reflector.getAllAndOverride<boolean | undefined>(AUDITED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isAudited) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const correlationId = getRequestId(request);

    return next
      .handle()
      .pipe(
        concatMap((responseBody: unknown) =>
          from(this.persistStagedEntries(request, correlationId)).pipe(map(() => responseBody)),
        ),
      );
  }

  /**
   * Throws — converting the response into a 500 via Nest's ordinary
   * exception handling — when a route marked `@Audited()` completes having
   * staged nothing. This is what makes the sprint's central claim testable:
   * remove this interceptor from the module graph, and a PHI write that
   * forgets `stageAuditEntry()` (or one that never had the interceptor
   * enforcing it in the first place) succeeds with no audit row at all,
   * silently. With the interceptor present, the same missing-stage bug
   * fails loudly instead of shipping unaudited.
   */
  private async persistStagedEntries(
    request: Request,
    correlationId: string | undefined,
  ): Promise<void> {
    const entries = drainAuditEntries(request);
    if (entries.length === 0) {
      throw new Error(
        'AuditInterceptor: route is marked @Audited() but completed with no staged audit entries. ' +
          'Every PHI write must call stageAuditEntry() (audit-recorder.ts) before returning.',
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
}
