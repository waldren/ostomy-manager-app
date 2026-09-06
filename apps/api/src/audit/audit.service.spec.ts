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

import { describe, expect, it, vi } from 'vitest';

import { AuditService } from './audit.service';
import type { AuditContext } from './audit-context';

function fakePrisma() {
  return {
    auditEvent: {
      create: vi.fn().mockResolvedValue({ id: 'created-audit-event-id' }),
    },
  };
}

function baseContext(overrides: Partial<AuditContext> = {}): AuditContext {
  return {
    actorType: 'PATIENT',
    actorId: 'patient-subject-1',
    action: 'CREATE',
    entityType: 'audit_stub_widget',
    entityId: 'entity-1',
    ...overrides,
  };
}

describe('AuditService.record()', () => {
  it('refuses to write an audit row with no actorId — never a null actor', async () => {
    const prisma = fakePrisma();
    const service = new AuditService(prisma as never);

    await expect(service.record(baseContext({ actorId: '' }))).rejects.toThrow(
      /actorId is required/,
    );
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it('refuses to write an audit row with no entityId', async () => {
    const prisma = fakePrisma();
    const service = new AuditService(prisma as never);

    await expect(service.record(baseContext({ entityId: '' }))).rejects.toThrow(
      /entityId is required/,
    );
    expect(prisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it('writes actor identity, action, entity, and reason code through unchanged', async () => {
    const prisma = fakePrisma();
    const service = new AuditService(prisma as never);

    await service.record(
      baseContext({ reasonCode: 'direct_write', afterValue: { note: 'synthetic' } }),
    );

    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorType: 'PATIENT',
        actorId: 'patient-subject-1',
        action: 'CREATE',
        entityType: 'audit_stub_widget',
        entityId: 'entity-1',
        reasonCode: 'direct_write',
        afterValue: { note: 'synthetic' },
      }),
    });
  });

  it('leaves beforeValue/afterValue undefined (column NULL) when no correlationId is supplied', async () => {
    const prisma = fakePrisma();
    const service = new AuditService(prisma as never);

    await service.record(baseContext({ afterValue: { note: 'synthetic' } }));

    const call = prisma.auditEvent.create.mock.calls[0]![0];
    expect(call.data.beforeValue).toBeUndefined();
    expect(call.data.afterValue).toEqual({ note: 'synthetic' });
  });

  it('nests correlationId into afterValue when both are present, preserving a NULL beforeValue for a CREATE', async () => {
    const prisma = fakePrisma();
    const service = new AuditService(prisma as never);

    await service.record(
      baseContext({ afterValue: { note: 'synthetic' }, correlationId: 'req-123' }),
    );

    const call = prisma.auditEvent.create.mock.calls[0]![0];
    expect(call.data.beforeValue).toBeUndefined();
    expect(call.data.afterValue).toEqual({
      correlationId: 'req-123',
      entity: { note: 'synthetic' },
    });
  });

  it('falls back to nesting correlationId into beforeValue for a DELETE (no afterValue)', async () => {
    const prisma = fakePrisma();
    const service = new AuditService(prisma as never);

    await service.record(
      baseContext({
        action: 'DELETE',
        beforeValue: { note: 'synthetic' },
        correlationId: 'req-456',
      }),
    );

    const call = prisma.auditEvent.create.mock.calls[0]![0];
    expect(call.data.afterValue).toBeUndefined();
    expect(call.data.beforeValue).toEqual({
      correlationId: 'req-456',
      entity: { note: 'synthetic' },
    });
  });

  it('still records correlationId when neither beforeValue nor afterValue is supplied', async () => {
    const prisma = fakePrisma();
    const service = new AuditService(prisma as never);

    await service.record(baseContext({ correlationId: 'req-789' }));

    const call = prisma.auditEvent.create.mock.calls[0]![0];
    expect(call.data.afterValue).toEqual({ correlationId: 'req-789', entity: null });
  });
});
