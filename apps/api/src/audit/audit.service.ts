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
import type { AuditAction, AuditActorType, AuditContext } from './audit-context';

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
   * Correlation-id placement (P2.S1a): the `audit_events.correlation_id`
   * **column**, indexed, exactly as `prisma/schema.prisma` describes it.
   *
   * P1.S5 could not touch `prisma/` and therefore nested this value inside
   * `beforeValue`/`afterValue` as `{ correlationId, entity: <value> }`; the
   * follow-up migration `20260906203344_add_audit_correlation_id` added the
   * column specifically so that this sprint — the first one writing real
   * clinical rows — would not make the wrapped shape permanent. That column
   * landed with nothing writing to it, which this method now does. The
   * wrapper is gone: `beforeValue`/`afterValue` again hold the entity's own
   * fields and nothing else, which is what makes "reconstruct this record's
   * history" a straight column read rather than an unwrapping step every
   * future reader would have to know about. Nothing needed migrating,
   * because the only rows ever written in the wrapped shape were synthetic
   * test scaffolding — and `audit_events` has no UPDATE grant, so had real
   * rows existed they could never have been normalised (ADR-0011).
   *
   * `tx` (B2, P1.S5 review response): optional `Prisma.TransactionClient`,
   * defaulting to `this.prisma` when omitted. Without it, the PHI write and
   * its audit row are always two separate transactions, in that order —
   * `AuditInterceptor` runs only after the handler's observable emits, so
   * the PHI write has already committed by the time this method is even
   * called. A failure here then either goes unnoticed (pre-B1) or fails the
   * response after the PHI row is already durable (post-B1) — the client
   * retries, and for the mobile sync queue that means re-pushing an
   * operation whose write already landed. Passing `tx` does not change
   * either behaviour by itself: `AuditInterceptor` still calls `record()`
   * after the handler returns for any entry staged the ordinary way.
   *
   * P2.S1a is the first caller to pass it. `ObservationsService.create()`
   * opens a `$transaction`, writes the observation, calls
   * `record(context, tx)` inside it, and then stages the entry with
   * `stageCommittedAuditEntry()` (audit-recorder.ts) so the interceptor
   * counts it for coverage without writing it twice. Every later PHI write
   * path — P2.S1b's sync-applied and conflict-loser rows especially, where
   * one route applies many operations — should follow that shape rather
   * than re-deriving it.
   */
  async record(context: AuditContext, tx?: Prisma.TransactionClient): Promise<{ id: string }> {
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

    const beforeValue = toInputJsonValue(context.beforeValue);
    const afterValue = toInputJsonValue(context.afterValue);

    const client = tx ?? this.prisma;
    let created: { id: string };
    try {
      created = await client.auditEvent.create({
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
          correlationId: context.correlationId ?? null,
          ...(beforeValue !== undefined ? { beforeValue } : {}),
          ...(afterValue !== undefined ? { afterValue } : {}),
        },
      });
    } catch (error) {
      // B3 (P1.S5 review response): NEVER let the raw Prisma error escape
      // this method. This is the first and only code in this repo that
      // hands clinical before/after values to Prisma as a `create()`
      // argument, and `PrismaClientValidationError` renders that argument —
      // the offending `data`, i.e. the clinical value itself — into its own
      // `.message` string. `logging/serializers.ts`'s `errSerializer`
      // allow-lists `message` through verbatim (it is meant to; that is
      // correct for an ordinary application error), and the redaction lists
      // in `logging/redaction.ts` match object *paths*
      // (`err.meta`/`err.query`/`err.params`), not substrings *inside* a
      // message string — so an uncaught Prisma error here would put PHI on
      // the wire to application logs the moment `audit_events.create()`
      // itself ever fails (a full disk, a constraint violation, a bad JSON
      // shape). Wrapping in `AuditPersistenceError` — entityType, entityId,
      // action, actorType, and only the original error's `name`/`code` —
      // is what keeps that from ever reaching a log line. Do NOT widen
      // `errSerializer` or the redaction lists to "fix" this instead: a
      // deny-list cannot match a substring inside an arbitrary message.
      throw new AuditPersistenceError(context, error);
    }
    return { id: created.id };
  }
}

/**
 * Thrown by `AuditService.record()` in place of whatever
 * `prisma.auditEvent.create()` itself threw (B3) — carries only
 * non-PHI-shaped identifying fields plus the original error's `name`/`code`,
 * never the original error object and never its `message`, which for a
 * `PrismaClientValidationError` can render the offending `data` argument
 * (i.e. the clinical value itself) verbatim. Callers that need to log a
 * `record()` failure (`AuditInterceptor.persistOnError`, B1) can safely log
 * this error's own `message`/fields — that is the property this class
 * exists to guarantee.
 */
export class AuditPersistenceError extends Error {
  /**
   * Opts this type's `message` into being logged verbatim by
   * `ErrorSanitizerFilter` (`http/error-sanitizer.filter.ts`). Safe here by
   * construction: the message is assembled from `entityId`/`action`/type
   * names and the original error's `name`/`code` only — never the original
   * error object, and never its `message`, which for a Prisma validation
   * error renders the offending `data` verbatim.
   */
  readonly phiSafeMessage = true as const;

  readonly entityType: string;
  readonly entityId: string;
  readonly action: AuditAction;
  readonly actorType: AuditActorType;
  readonly originalErrorName: string | undefined;
  readonly originalErrorCode: string | number | undefined;

  constructor(context: AuditContext, originalError: unknown) {
    const originalErrorName = originalError instanceof Error ? originalError.name : undefined;
    const rawCode = (originalError as { code?: unknown } | null | undefined)?.code;
    const originalErrorCode =
      typeof rawCode === 'string' || typeof rawCode === 'number' ? rawCode : undefined;

    super(
      `AuditService.record(): failed to persist an audit_events row for ` +
        `${context.entityType}/${context.entityId} (${context.action}). ` +
        `Underlying error: ${originalErrorName ?? 'unknown'}` +
        (originalErrorCode !== undefined ? ` (code ${originalErrorCode})` : '') +
        `. The original error's message is deliberately not included — it may embed the ` +
        `offending clinical value (see this class's own doc comment).`,
    );
    this.name = 'AuditPersistenceError';
    this.entityType = context.entityType;
    this.entityId = context.entityId;
    this.action = context.action;
    this.actorType = context.actorType;
    this.originalErrorName = originalErrorName;
    this.originalErrorCode = originalErrorCode;
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
