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
 * The admin threshold controller.
 *
 * Neither PR A nor PR B had a controller spec, which left three load-bearing things
 * untested: that the request is validated at all, that the 400 names the refused field
 * without echoing the value, and that the audit entry is staged with the ids the
 * interceptor checks. A reviewer pointed out that removing `safeParse` entirely would
 * leave every other test green while an unvalidated `1e9` reached Prisma as a `numeric
 * field overflow` — a 500 on an admin route for what is an input error.
 *
 * A unit spec with a stub service, so it runs without Docker. The integration suite
 * skips itself when Docker is unreachable, and "never echo the value" is exactly the
 * habit a later edit breaks silently.
 */
import { BadRequestException } from '@nestjs/common';
import type { Request } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { AdminThresholdsController } from './admin-thresholds.controller';
import { THRESHOLD_ENTITY_TYPE } from './admin-thresholds.service';

const SNAPSHOT = {
  thresholdKey: 'stoma_output_single_entry_warning_ml',
  tier: 'TIER_2_SOFT_WARNING' as const,
  value: 1500,
  unit: 'mL',
  patientAdjustable: true,
  description: 'a label',
};

function makeController(overrides: { update?: unknown; list?: unknown } = {}) {
  const update = vi.fn(async () => ({
    threshold: SNAPSHOT,
    thresholdId: 'threshold-row-id',
    auditEventId: 'audit-row-id',
    updatedAt: '2026-10-01T00:00:00.000Z',
  }));
  const list = vi.fn(async () => ({ thresholds: [] }));
  const service = {
    updateThreshold: overrides.update ?? update,
    listThresholds: overrides.list ?? list,
  };
  return {
    controller: new AdminThresholdsController(service as never),
    update,
    list,
  };
}

/**
 * Runs an update expected to be refused and returns the exception's body.
 *
 * A helper rather than `.catch(e => e)` inline, because that widens to a union with the
 * success type and every assertion then needs a cast — which is how a test stops
 * checking what it says it checks.
 */
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
  throw new Error('expected the update to be refused, and it was not');
}

/** A request carrying a verified admin subject, as `AdminJwtAuthGuard` leaves it. */
function adminRequest(id = 'admin-subject'): Request {
  return { admin: { id }, id: 'request-id-1' } as unknown as Request;
}

describe('validation happens, and its failures name fields rather than values', () => {
  it('rejects a body the schema refuses, without calling the service', async () => {
    const { controller, update } = makeController();

    await expect(
      controller.update('some_key', { value: 1e9, description: null }, adminRequest()),
    ).rejects.toBeInstanceOf(BadRequestException);
    // The point: an unvalidated value reaching Prisma is a 500 for an input error.
    expect(update).not.toHaveBeenCalled();
  });

  /**
   * The assertion the controller's own comment used to claim and not deliver. An
   * `unrecognized_keys` issue carries `path: []`, so reporting `issue.path` named no
   * field at all — and the admin was told "something you sent is not recognised" for
   * the two most interesting rejections this surface has.
   */
  it('names the immutable field a caller tried to change', async () => {
    const { controller } = makeController();

    await expect(
      controller.update(
        'some_key',
        { value: 1500, description: null, tier: 'TIER_1_HARD_BLOCK' },
        adminRequest(),
      ),
    ).rejects.toMatchObject({
      response: {
        error: {
          code: 'INVALID_THRESHOLD_UPDATE',
          fields: [{ field: 'tier', rule: 'immutable_field' }],
        },
      },
    });
  });

  it('names several refused fields rather than collapsing them into one', async () => {
    const { controller } = makeController();

    const body = await refusalBody(() =>
      controller.update(
        'some_key',
        { value: 1500, description: null, tier: 'OPERATIONAL', unit: 'L' },
        adminRequest(),
      ),
    );

    expect(body.error.fields).toEqual([
      { field: 'tier', rule: 'immutable_field' },
      { field: 'unit', rule: 'immutable_field' },
    ]);
  });

  /**
   * CLAUDE.md: a validation error returns field identifiers and rule codes, never the
   * offending value. Zod's `message` can quote the input, which is why it is dropped —
   * and nothing was checking that it stays dropped.
   */
  it('never echoes the value it refused', async () => {
    const { controller } = makeController();

    const serialised = JSON.stringify(
      await refusalBody(() =>
        controller.update('some_key', { value: -4321, description: null }, adminRequest()),
      ),
    );
    expect(serialised).not.toContain('4321');
    expect(serialised).not.toContain('message');
  });

  it('does not reflect an arbitrary unknown key back to the caller', async () => {
    // The refused-key list is intersected with the known immutable fields rather than
    // echoed, so a caller cannot get input reflected by sending it as a key.
    const { controller } = makeController();

    const body = await refusalBody(() =>
      controller.update(
        'some_key',
        { value: 1500, description: null, 'x-injected-9f3': 'nope' },
        adminRequest(),
      ),
    );

    expect(JSON.stringify(body)).not.toContain('x-injected-9f3');
  });
});

describe('the audit entry is staged with what the interceptor checks', () => {
  it('stages the row id and the committed audit id', async () => {
    const { controller } = makeController();
    const request = adminRequest();

    await controller.update('some_key', { value: 1500, description: null }, request);

    expect(request.auditEntries).toEqual([
      expect.objectContaining({
        entityType: THRESHOLD_ENTITY_TYPE,
        entityId: 'threshold-row-id',
        auditEventId: 'audit-row-id',
        persisted: true,
        actorType: 'ADMIN',
        actorId: 'admin-subject',
        action: 'UPDATE',
      }),
    ]);
  });

  it('passes the verified admin subject through, never a value from the body', async () => {
    const { controller, update } = makeController();

    await controller.update(
      'some_key',
      { value: 1500, description: null },
      adminRequest('admin-7'),
    );

    expect(update).toHaveBeenCalledWith(
      'some_key',
      { value: 1500, description: null },
      'admin-7',
      'request-id-1',
    );
  });
});

describe('the success body', () => {
  it('returns the persisted row plus the token for the next write', async () => {
    // Without `updatedAt` a caller must re-GET before it can make a second change.
    const { controller } = makeController();

    const body = await controller.update(
      'some_key',
      { value: 1500, description: null },
      adminRequest(),
    );

    expect(body).toEqual({ ...SNAPSHOT, updatedAt: '2026-10-01T00:00:00.000Z' });
  });
});
