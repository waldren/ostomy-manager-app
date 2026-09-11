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

  it('leaves beforeValue/afterValue undefined (column NULL) when it is not given one', async () => {
    const prisma = fakePrisma();
    const service = new AuditService(prisma as never);

    await service.record(baseContext({ afterValue: { note: 'synthetic' } }));

    const call = prisma.auditEvent.create.mock.calls[0]![0];
    expect(call.data.beforeValue).toBeUndefined();
    expect(call.data.afterValue).toEqual({ note: 'synthetic' });
  });

  // P1.S5 wrote the correlation id *inside* whichever JSON value column was
  // populated, as `{ correlationId, entity }`, because that sprint could not
  // touch prisma/. The column landed in migration
  // 20260906203344_add_audit_correlation_id and P2.S1a — the first sprint
  // writing real clinical rows — starts using it, before the wrapped shape
  // could become permanent in a table with no UPDATE grant (ADR-0011). These
  // three cases are the old nesting tests, rewritten against the column.
  it('writes correlationId to its own column and leaves afterValue holding the entity alone', async () => {
    const prisma = fakePrisma();
    const service = new AuditService(prisma as never);

    await service.record(
      baseContext({ afterValue: { note: 'synthetic' }, correlationId: 'req-123' }),
    );

    const call = prisma.auditEvent.create.mock.calls[0]![0];
    expect(call.data.correlationId).toBe('req-123');
    expect(call.data.beforeValue).toBeUndefined();
    // No wrapper: a future reader reconstructing a record's history reads
    // the entity's fields directly rather than unwrapping an `entity` key.
    expect(call.data.afterValue).toEqual({ note: 'synthetic' });
  });

  it('does the same for a DELETE, whose populated side is beforeValue', async () => {
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
    expect(call.data.correlationId).toBe('req-456');
    expect(call.data.afterValue).toBeUndefined();
    expect(call.data.beforeValue).toEqual({ note: 'synthetic' });
  });

  it('records correlationId even when neither beforeValue nor afterValue is supplied', async () => {
    const prisma = fakePrisma();
    const service = new AuditService(prisma as never);

    await service.record(baseContext({ correlationId: 'req-789' }));

    const call = prisma.auditEvent.create.mock.calls[0]![0];
    expect(call.data.correlationId).toBe('req-789');
    // Both value columns stay genuinely absent. Under the old nesting they
    // could not: the correlation id had to be smuggled into `afterValue` as
    // `{ correlationId, entity: null }`, which read as "there was an after
    // state and it was null".
    expect(call.data.afterValue).toBeUndefined();
    expect(call.data.beforeValue).toBeUndefined();
  });

  it('writes an explicit NULL correlationId when the caller has no request context', async () => {
    const prisma = fakePrisma();
    const service = new AuditService(prisma as never);

    await service.record(baseContext({ afterValue: { note: 'synthetic' } }));

    // `null`, not `undefined`: ADR-0001's conflict-loser row is audited with
    // no originating request, and the column must say so rather than be
    // omitted from the INSERT and left to a default.
    expect(prisma.auditEvent.create.mock.calls[0]![0].data.correlationId).toBeNull();
  });
});
