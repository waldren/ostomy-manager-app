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
 * The admin default-range controller.
 *
 * A unit spec with a stub service, so it runs without Docker — the integration suite
 * skips itself when Docker is unreachable, and "the 400 names the field and never the
 * value" is exactly the habit a later edit breaks silently. PR B added the first of
 * these after a reviewer pointed out that deleting `safeParse` would leave every other
 * test green while an unvalidated number reached Prisma as a 500.
 */
import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { AdminDefaultRangesController, rowIdPipe } from './admin-default-ranges.controller';
import { DEFAULT_RANGE_ENTITY_TYPE } from './admin-default-ranges.service';

const SNAPSHOT = {
  ostomyType: 'ILEOSTOMY' as const,
  rangeType: 'daily_output_ml',
  minDaysPostOp: 0,
  maxDaysPostOp: 30,
  lowValue: 500,
  highValue: 1200,
  unit: 'mL',
  windowDays: null,
};

const VALID_CREATE = { ...SNAPSHOT };
const VALID_UPDATE = { lowValue: 400, highValue: 1100 };
const ROW_ID = '11111111-1111-4111-8111-111111111111';

function makeController() {
  const createDefaultRange = vi.fn(async () => ({
    range: SNAPSHOT,
    rangeId: ROW_ID,
    auditEventId: 'audit-create',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }));
  const updateDefaultRange = vi.fn(async () => ({
    range: SNAPSHOT,
    rangeId: ROW_ID,
    auditEventId: 'audit-update',
    updatedAt: '2026-10-01T01:00:00.000Z',
  }));
  const deleteDefaultRange = vi.fn(async () => ({
    range: SNAPSHOT,
    rangeId: ROW_ID,
    auditEventId: 'audit-delete',
  }));
  const service = {
    createDefaultRange,
    updateDefaultRange,
    deleteDefaultRange,
    listDefaultRanges: vi.fn(async () => ({ defaultRanges: [] })),
  };
  return {
    controller: new AdminDefaultRangesController(service as never),
    createDefaultRange,
    updateDefaultRange,
    deleteDefaultRange,
  };
}

function adminRequest(id = 'admin-subject'): Request {
  return { admin: { id }, id: 'request-id-1' } as unknown as Request;
}

async function refusalBody(
  run: () => Promise<unknown>,
): Promise<{ error: { code: string; fields: { field: string; rule: string }[] } }> {
  try {
    await run();
  } catch (error) {
    return (
      error as { response: { error: { code: string; fields: { field: string; rule: string }[] } } }
    ).response;
  }
  throw new Error('expected the request to be refused, and it was not');
}

describe('validation happens before the service is reached', () => {
  it('refuses a create the schema rejects, without calling the service', async () => {
    const { controller, createDefaultRange } = makeController();

    await expect(
      controller.create({ ...VALID_CREATE, lowValue: null, highValue: null }, adminRequest()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(createDefaultRange).not.toHaveBeenCalled();
  });

  it('refuses an update the schema rejects, without calling the service', async () => {
    const { controller, updateDefaultRange } = makeController();

    await expect(
      controller.update(ROW_ID, { lowValue: 1e9, highValue: null }, adminRequest()),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(updateDefaultRange).not.toHaveBeenCalled();
  });

  /**
   * The identity fields are what make a row *which* default it is, so an update that
   * silently ignored one would let an admin believe they had moved a window.
   */
  it('names the identity field an update tried to change', async () => {
    const { controller } = makeController();

    const body = await refusalBody(() =>
      controller.update(ROW_ID, { ...VALID_UPDATE, maxDaysPostOp: 60 }, adminRequest()),
    );

    expect(body.error).toMatchObject({
      code: 'INVALID_DEFAULT_RANGE_UPDATE',
      fields: [{ field: 'maxDaysPostOp', rule: 'immutable_field' }],
    });
  });

  it('never echoes the value it refused', async () => {
    const { controller } = makeController();

    const serialised = JSON.stringify(
      await refusalBody(() =>
        controller.update(ROW_ID, { lowValue: 987654321, highValue: null }, adminRequest()),
      ),
    );

    expect(serialised).not.toContain('987654321');
    expect(serialised).not.toContain('message');
  });

  it('does not reflect an arbitrary unknown key back to the caller', async () => {
    const { controller } = makeController();

    const body = await refusalBody(() =>
      controller.update(ROW_ID, { ...VALID_UPDATE, 'x-injected-7b2': 'nope' }, adminRequest()),
    );

    expect(JSON.stringify(body)).not.toContain('x-injected-7b2');
  });
});

describe('every mutating route stages its audit entry', () => {
  it('stages a CREATE with the row id and the committed audit id', async () => {
    const { controller } = makeController();
    const request = adminRequest();

    await controller.create(VALID_CREATE, request);

    expect(request.auditEntries).toEqual([
      expect.objectContaining({
        entityType: DEFAULT_RANGE_ENTITY_TYPE,
        entityId: ROW_ID,
        auditEventId: 'audit-create',
        persisted: true,
        action: 'CREATE',
        actorType: 'ADMIN',
        actorId: 'admin-subject',
      }),
    ]);
  });

  it('stages an UPDATE', async () => {
    const { controller } = makeController();
    const request = adminRequest();

    await controller.update(ROW_ID, VALID_UPDATE, request);

    expect(request.auditEntries?.[0]).toMatchObject({
      action: 'UPDATE',
      auditEventId: 'audit-update',
    });
  });

  /**
   * The one that matters most: after a delete the audit row is the only place the row
   * exists, so an unstaged entry would mean the `@Audited()` coverage check passes while
   * nothing records what was removed.
   */
  it('stages a DELETE', async () => {
    const { controller } = makeController();
    const request = adminRequest();

    await controller.remove(ROW_ID, request);

    expect(request.auditEntries?.[0]).toMatchObject({
      action: 'DELETE',
      auditEventId: 'audit-delete',
    });
  });

  it('passes the verified admin subject through, never a value from the body', async () => {
    const { controller, createDefaultRange } = makeController();

    await controller.create(VALID_CREATE, adminRequest('admin-9'));

    expect(createDefaultRange).toHaveBeenCalledWith(VALID_CREATE, 'admin-9', 'request-id-1');
  });
});

describe('the success bodies', () => {
  it('returns the created row with its id and token', async () => {
    const { controller } = makeController();

    expect(await controller.create(VALID_CREATE, adminRequest())).toEqual({
      ...SNAPSHOT,
      id: ROW_ID,
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('returns what a deleted row said, which is otherwise only in the audit log', async () => {
    const { controller } = makeController();

    // Plus the id, so a console can reconcile which row went. `updatedAt` is
    // genuinely absent: a row that no longer exists has no last-modified time.
    expect(await controller.remove(ROW_ID, adminRequest())).toEqual({ ...SNAPSHOT, id: ROW_ID });
  });
});

/**
 * The malformed-id 400, tested on the shipped pipe instance.
 *
 * It cannot be reached through the controller's methods — direct calls bypass pipes —
 * and reaching it over HTTP needs the admin JWKS harness. Exercising the instance is
 * what proves the shape the route actually serves.
 *
 * `ParseUUIDPipe`'s default throws a message-bearing body, which `ErrorSanitizerFilter`
 * correctly refuses to forward and rewrites to `{ error: { code: 'BAD_REQUEST' } }` —
 * safe, but it would make a malformed id answer in a different vocabulary from a
 * malformed body. An authored body with neither `statusCode` nor `message` passes the
 * filter untouched and keeps the code set closed.
 */
describe('a malformed row id', () => {
  const meta = { type: 'param' as const, data: 'id' };

  it('is refused with this surface’s own code, not a framework message', async () => {
    await expect(rowIdPipe.transform('not-a-uuid', meta)).rejects.toMatchObject({
      response: { error: { code: 'INVALID_DEFAULT_RANGE_ID' } },
    });
  });

  it('carries neither statusCode nor message, so the error filter forwards it as authored', async () => {
    const body = await rowIdPipe
      .transform('not-a-uuid', meta)
      .then(() => undefined)
      .catch((error: unknown) => (error as { response: Record<string, unknown> }).response);

    expect(Object.keys(body ?? {})).toEqual(['error']);
  });

  it('accepts a real row id', async () => {
    await expect(rowIdPipe.transform(ROW_ID, meta)).resolves.toBe(ROW_ID);
  });
});
