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
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';

import { AuditInterceptor } from './audit.interceptor';
import { stageAuditEntry } from './audit-recorder';

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

describe('AuditInterceptor', () => {
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
