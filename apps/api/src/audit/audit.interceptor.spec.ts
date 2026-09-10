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

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { firstValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { AuditInterceptor } from './audit.interceptor';
import { stageAuditEntry, stageCommittedAuditEntry } from './audit-recorder';

function fakeAuditService() {
  return { record: vi.fn().mockResolvedValue({ id: 'audit-row-id' }) };
}

function fakeReflector(isAudited: boolean | undefined) {
  return { getAllAndOverride: vi.fn().mockReturnValue(isAudited) };
}

function fakeHttpContext(request: Record<string, unknown>): ExecutionContext {
  return {
    getType: () => 'http',
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => undefined,
    }),
  } as unknown as ExecutionContext;
}

function handlerReturning(value: unknown): CallHandler {
  return { handle: () => of(value) };
}

/** A handler that fails, as P2.S1b's sync push will when operation N+1 throws. */
function handlerThrowing(error: Error): CallHandler {
  return { handle: () => throwError(() => error) };
}

describe('AuditInterceptor', () => {
  // B1 regression (P1.S5 review). `concatMap`'s project function only runs on
  // the success channel, so before the `catchError` branch existed a handler
  // that staged N entries and then threw lost every one of them silently: no
  // persist, no log, no failure mentioning audit at all. The concrete case is
  // P2.S1b's sync push committing operations 1..N and then failing on N+1 —
  // N PHI writes standing with zero audit rows, which is the exact gap this
  // sprint exists to close, on the path ADR-0001 calls the one that gets
  // missed. These two tests are the reason that cannot regress.
  it('persists staged entries when the handler throws, then re-throws the original error (B1)', async () => {
    const auditService = fakeAuditService();
    const interceptor = new AuditInterceptor(fakeReflector(true) as never, auditService as never);
    const request: Record<string, unknown> = { id: 'req-boom' };
    const handlerError = new Error('operation 11 of 20 failed');

    stageAuditEntry(request as never, {
      actorType: 'PATIENT',
      actorId: 'patient-1',
      action: 'CREATE',
      entityType: 'audit_stub_widget',
      entityId: 'entity-committed-before-the-throw',
      afterValue: { note: 'synthetic' },
    });

    await expect(
      firstValueFrom(
        interceptor.intercept(fakeHttpContext(request), handlerThrowing(handlerError)),
      ),
      // The original failure must still reach the client — the audit write is
      // recovery, not a way to turn a failed request into a successful one.
    ).rejects.toBe(handlerError);

    expect(auditService.record).toHaveBeenCalledTimes(1);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'entity-committed-before-the-throw' }),
    );
  });

  it('re-throws the handler error even when nothing was staged (B1)', async () => {
    const auditService = fakeAuditService();
    const interceptor = new AuditInterceptor(fakeReflector(true) as never, auditService as never);
    const handlerError = new Error('failed before staging anything');

    await expect(
      firstValueFrom(
        interceptor.intercept(fakeHttpContext({ id: 'req-early' }), handlerThrowing(handlerError)),
      ),
      // A handler that failed before staging is not a missing-audit defect —
      // it must not be masked by the "staged nothing" error the success path
      // raises.
    ).rejects.toBe(handlerError);

    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('passes non-audited routes straight through, never touching AuditService', async () => {
    const auditService = fakeAuditService();
    const interceptor = new AuditInterceptor(
      fakeReflector(undefined) as never,
      auditService as never,
    );
    const request = { id: 'req-1' };

    const result = await firstValueFrom(
      interceptor.intercept(fakeHttpContext(request), handlerReturning({ ok: true })),
    );

    expect(result).toEqual({ ok: true });
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('persists a staged entry, filling in the correlation id from the request, on an audited route', async () => {
    const auditService = fakeAuditService();
    const interceptor = new AuditInterceptor(fakeReflector(true) as never, auditService as never);
    const request: Record<string, unknown> = { id: 'req-42' };
    stageAuditEntry(request as never, {
      actorType: 'PATIENT',
      actorId: 'patient-1',
      action: 'CREATE',
      entityType: 'audit_stub_widget',
      entityId: 'entity-1',
      afterValue: { note: 'synthetic' },
    });

    const result = await firstValueFrom(
      interceptor.intercept(fakeHttpContext(request), handlerReturning({ id: 'entity-1' })),
    );

    expect(result).toEqual({ id: 'entity-1' });
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'patient-1',
        entityId: 'entity-1',
        correlationId: 'req-42',
      }),
    );
  });

  it('persists every staged entry when a handler stages more than one (a future batch endpoint, e.g. sync push)', async () => {
    const auditService = fakeAuditService();
    const interceptor = new AuditInterceptor(fakeReflector(true) as never, auditService as never);
    const request: Record<string, unknown> = { id: 'req-batch' };
    stageAuditEntry(request as never, {
      actorType: 'PATIENT',
      actorId: 'patient-1',
      action: 'CREATE',
      entityType: 'observation',
      entityId: 'entity-a',
      afterValue: { value: 1 },
    });
    stageAuditEntry(request as never, {
      actorType: 'PATIENT',
      actorId: 'patient-1',
      action: 'CREATE',
      entityType: 'observation',
      entityId: 'entity-b',
      afterValue: { value: 2 },
    });

    await firstValueFrom(
      interceptor.intercept(fakeHttpContext(request), handlerReturning({ ok: true })),
    );

    expect(auditService.record).toHaveBeenCalledTimes(2);
  });

  it('throws — never silently succeeds — when an audited route completes with nothing staged', async () => {
    const auditService = fakeAuditService();
    const interceptor = new AuditInterceptor(fakeReflector(true) as never, auditService as never);
    const request: Record<string, unknown> = { id: 'req-forgot-to-stage' };

    await expect(
      firstValueFrom(
        interceptor.intercept(fakeHttpContext(request), handlerReturning({ ok: true })),
      ),
    ).rejects.toThrow(/no staged audit entries/);
    expect(auditService.record).not.toHaveBeenCalled();
  });

  // P2.S1a. `ObservationsService.create()` writes its own audit row inside
  // the PHI write's transaction, so the interceptor must NOT write it again
  // — `audit_events` has no DELETE grant (ADR-0011), so a duplicate is
  // permanent — while the route must still satisfy the coverage trip-wire.
  // Moving the write into the transaction must not cost the check that
  // catches a PHI write with no audit row at all.
  // The flag is only a control if it cannot be set without the thing it
  // asserts. Before this, `stageCommittedAuditEntry()` took the caller's
  // word, so a handler that forgot `record(ctx, tx)` wrote PHI with no audit
  // row and passed every trip-wire — the route was decorated, entries were
  // staged, and the interceptor skipped them all.
  it.each([
    ['an empty id', ''],
    ['a missing id', undefined],
  ])('refuses to stage a committed entry with %s — the id IS the proof', (_label, id) => {
    const request: Record<string, unknown> = { id: 'req-unproven' };

    expect(() =>
      stageCommittedAuditEntry(
        request as never,
        {
          actorType: 'PATIENT',
          actorId: 'patient-1',
          action: 'CREATE',
          entityType: 'observation',
          entityId: 'entity-1',
        },
        id as never,
      ),
    ).toThrow(/requires the id returned by AuditService\.record/);

    // And nothing was staged, so the @Audited() trip-wire still fires for
    // this route rather than being satisfied by a rejected entry.
    expect(request.auditEntries).toBeUndefined();
  });

  it('does not re-persist an entry the handler already committed in its own transaction', async () => {
    const auditService = fakeAuditService();
    const interceptor = new AuditInterceptor(fakeReflector(true) as never, auditService as never);
    const request: Record<string, unknown> = { id: 'req-committed' };
    stageCommittedAuditEntry(
      request as never,
      {
        actorType: 'PATIENT',
        actorId: 'patient-1',
        action: 'CREATE',
        entityType: 'observation',
        entityId: 'entity-1',
        afterValue: { valueQuantityValue: 350.5 },
      },
      'audit-row-1',
    );

    const result = await firstValueFrom(
      interceptor.intercept(fakeHttpContext(request), handlerReturning({ id: 'entity-1' })),
    );

    // The route passed the trip-wire (no "no staged audit entries" throw)
    // and nothing was written a second time.
    expect(result).toEqual({ id: 'entity-1' });
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('still persists ordinary entries staged alongside a committed one', async () => {
    const auditService = fakeAuditService();
    const interceptor = new AuditInterceptor(fakeReflector(true) as never, auditService as never);
    const request: Record<string, unknown> = { id: 'req-mixed' };
    stageCommittedAuditEntry(
      request as never,
      {
        actorType: 'PATIENT',
        actorId: 'patient-1',
        action: 'CREATE',
        entityType: 'observation',
        entityId: 'entity-committed',
        afterValue: { value: 1 },
      },
      'audit-row-2',
    );
    stageAuditEntry(request as never, {
      actorType: 'PATIENT',
      actorId: 'patient-1',
      action: 'CREATE',
      entityType: 'observation',
      entityId: 'entity-staged',
      afterValue: { value: 2 },
    });

    await firstValueFrom(
      interceptor.intercept(fakeHttpContext(request), handlerReturning({ ok: true })),
    );

    expect(auditService.record).toHaveBeenCalledTimes(1);
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'entity-staged' }),
    );
  });

  it('does not persist a committed entry on the error path either', async () => {
    // The mirror image: that transaction either landed with its PHI write or
    // rolled back with it. Writing it here would claim a write that may
    // never have happened.
    const auditService = fakeAuditService();
    const interceptor = new AuditInterceptor(fakeReflector(true) as never, auditService as never);
    const request: Record<string, unknown> = { id: 'req-committed-then-failed' };
    stageCommittedAuditEntry(
      request as never,
      {
        actorType: 'PATIENT',
        actorId: 'patient-1',
        action: 'CREATE',
        entityType: 'observation',
        entityId: 'entity-1',
        afterValue: { value: 1 },
      },
      'audit-row-3',
    );

    await expect(
      firstValueFrom(
        interceptor.intercept(
          fakeHttpContext(request),
          handlerThrowing(new Error('serialization failure')),
        ),
      ),
    ).rejects.toThrow(/serialization failure/);
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it('propagates an AuditService failure as the response failure, rather than letting the response succeed unaudited', async () => {
    const auditService = fakeAuditService();
    auditService.record.mockRejectedValueOnce(new Error('database unavailable'));
    const interceptor = new AuditInterceptor(fakeReflector(true) as never, auditService as never);
    const request: Record<string, unknown> = { id: 'req-audit-fails' };
    stageAuditEntry(request as never, {
      actorType: 'PATIENT',
      actorId: 'patient-1',
      action: 'CREATE',
      entityType: 'audit_stub_widget',
      entityId: 'entity-1',
      afterValue: { note: 'synthetic' },
    });

    await expect(
      firstValueFrom(
        interceptor.intercept(fakeHttpContext(request), handlerReturning({ ok: true })),
      ),
    ).rejects.toThrow(/database unavailable/);
  });
});
