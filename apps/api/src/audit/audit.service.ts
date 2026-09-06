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

import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import type { AuditContext } from './audit-context';

/**
 * The single write path to `audit_events` (SRS §5.2, ADR-0011). Every other
 * file in this application that ends up writing an audit row — the global
 * `AuditInterceptor`, and any future direct caller such as P2.S1b's
 * sync-applied-write and last-write-wins-conflict-loser handling
 * (ADR-0001) — calls `record()` here rather than touching
 * `prisma.auditEvent` itself. That is what makes "every PHI mutation is
 * audited" a property of one reviewable function instead of a convention
 * repeated at every call site.
 *
 * Never call this with a value that has not already been validated as safe
 * to persist as `beforeValue`/`afterValue` — this method does not scrub,
 * redact, or otherwise inspect what it is given; it trusts the caller to
 * have already limited it to the entity's own fields (never wrap a raw
 * request body verbatim). `docs/security-hipaa.md` "Never log PHI" is about
 * *application logs*, not `audit_events` — this table is explicitly the one
 * place before/after PHI values are meant to live — but the same discipline
 * of never persisting more than the entity itself (no headers, no full
 * request objects, no unrelated in-memory state) still applies here.
 */
@Injectable()
export class AuditService {
  // Explicit `@Inject(PrismaService)`, not implicit type-based injection —
  // this codebase's existing DI (`JwtAuthGuard`, `AdminJwtAuthGuard`,
  // `PrismaService` itself) always supplies an explicit token, and matching
  // that convention here is not stylistic: Vitest's esbuild-based TS
  // transform does not emit `design:paramtypes` metadata
  // (`emitDecoratorMetadata` needs a real type-checking compiler pass,
  // which esbuild does not do), so a constructor param typed only as
  // `PrismaService` with no decorator resolves to `undefined` at runtime in
  // every test that boots this through real Nest DI — confirmed by hitting
  // exactly that failure while wiring this class into `AppModule`. `main.ts`
  // still runs the real, `tsc`-compiled output, where this bug would not
  // reproduce — which is exactly the kind of gap `app-http-surface.spec.ts`'s
  // own header comment (`app.init()` does not prove request-safety) warns
  // is easy to miss without it.
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Persists one audit row. Throws — never silently substitutes a default —
   * if `actorId` is missing, so a caller can never produce an audit row with
   * a null actor (the sprint's own explicit "must never silently read
   * `undefined` and write a null actor" requirement).
   *
   * Correlation-id placement (see `AuditContext.correlationId`'s doc comment
   * for why this exists rather than a dedicated column): nested as
   * `{ correlationId, entity: <value> }` inside whichever of
   * `beforeValue`/`afterValue` is populated, preferring `afterValue` (present
   * for CREATE and UPDATE) and falling back to `beforeValue` (present for
   * DELETE, where `afterValue` is legitimately absent). This preserves the
   * existing "NULL means this side genuinely does not apply" reading for the
   * *other* column in the common CREATE/DELETE cases — only the populated
   * side gains the wrapper. In the (currently unreached) case where neither
   * is supplied but a correlation id is, `afterValue` is written as
   * `{ correlationId, entity: null }` rather than silently dropping the
   * correlation id.
   */
  async record(context: AuditContext): Promise<{ id: string }> {
    if (!context.actorId) {
      throw new Error(
        'AuditService.record(): actorId is required — refusing to write an audit row with a null actor.',
      );
    }
    if (!context.entityId) {
      throw new Error(
        'AuditService.record(): entityId is required — an audit row must identify what changed.',
      );
    }

    let beforeValue = toInputJsonValue(context.beforeValue);
    let afterValue = toInputJsonValue(context.afterValue);

    if (context.correlationId !== undefined) {
      if (afterValue !== undefined) {
        afterValue = { correlationId: context.correlationId, entity: afterValue };
      } else if (beforeValue !== undefined) {
        beforeValue = { correlationId: context.correlationId, entity: beforeValue };
      } else {
        afterValue = { correlationId: context.correlationId, entity: null };
      }
    }

    const created = await this.prisma.auditEvent.create({
      data: {
        actorType: context.actorType,
        actorId: context.actorId,
        action: context.action,
        entityType: context.entityType,
        entityId: context.entityId,
        // `exactOptionalPropertyTypes` (see tsconfig.base.json) treats "key
        // omitted" and "key present with value `undefined`" as distinct —
        // Prisma's generated input types use the former (an optional key),
        // so an `undefined` local variable must be left out of `data`
        // entirely via a conditional spread, never assigned in as a value.
        reasonCode: context.reasonCode ?? null,
        ...(beforeValue !== undefined ? { beforeValue } : {}),
        ...(afterValue !== undefined ? { afterValue } : {}),
      },
    });
    return { id: created.id };
  }
}

/**
 * `undefined` (Prisma: "omit the field, leave the column at its default —
 * NULL for `beforeValue`/`afterValue`") must stay distinct from a JSON
 * `null` (Prisma: "set the column to the JSON literal `null`", via
 * `Prisma.JsonNull` — not used by any caller today, but this cast is where a
 * future one would need to route it). `unknown` is narrowed here rather than
 * accepted as `Prisma.InputJsonValue` on `AuditContext` itself, so this
 * module stays the only place that needs to know Prisma's JSON input shape.
 */
function toInputJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined ? undefined : (value as Prisma.InputJsonValue);
}
