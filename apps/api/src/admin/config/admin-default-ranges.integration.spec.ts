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
 * P3.S3 PR C, ADR-0008. Against real PostgreSQL, as the runtime role.
 *
 * Each test uses its own `rangeType`, following PR B's corrected fixture strategy:
 * nothing shared is mutated, so a failing assertion cannot leave state that makes the
 * next three tests fail for an unrelated reason, and `toHaveLength(1)` on the audit
 * rows stays meaningful. The table starts empty, which makes that easy here — there is
 * no seeded row to work around.
 *
 * The window arithmetic is unit-tested separately, because this suite skips itself when
 * Docker is unreachable and that function is what a silent clinical ambiguity rests on.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../audit/audit.service';
import { PrismaClient } from '../../generated/prisma/client';

import { adminDefaultRangesResponseSchema } from './admin-default-range-wire';
import {
  AdminDefaultRangesService,
  DEFAULT_RANGE_ENTITY_TYPE,
} from './admin-default-ranges.service';

const API_ROOT = path.resolve(__dirname, '..', '..', '..');

function isDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = isDockerAvailable();
if (!dockerAvailable) {
  if (process.env.CI) {
    throw new Error(
      '[admin-default-ranges.integration.spec.ts] Docker is not reachable, but CI is set — ' +
        'refusing to silently skip.',
    );
  }
  // eslint-disable-next-line no-console
  console.warn('[admin-default-ranges.integration.spec.ts] Docker is not reachable — skipping.');
}

const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'admin-default-ranges-integration-test-only-password';
const ADMIN_SUBJECT = 'admin-integration-subject';

describe.skipIf(!dockerAvailable)('AdminDefaultRangesService — real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let service: AdminDefaultRangesService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('ostomy_admin_ranges_test')
      .withUsername('ostomy_owner')
      .withPassword('owner-test-only-password')
      .start();
    const ownerDatabaseUrl = container.getConnectionUri();

    execFileSync(
      process.execPath,
      [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
      {
        cwd: API_ROOT,
        env: { ...process.env, MIGRATION_DATABASE_URL: ownerDatabaseUrl },
        stdio: 'pipe',
      },
    );

    const owner = new PgClient({ connectionString: ownerDatabaseUrl });
    await owner.connect();
    try {
      await owner.query(`ALTER ROLE "${RUNTIME_ROLE}" WITH LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
    } finally {
      await owner.end();
    }

    const runtimeDatabaseUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@${container.getHost()}:${String(container.getPort())}/ostomy_admin_ranges_test`;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeDatabaseUrl }) });
    service = new AdminDefaultRangesService(
      prisma as never,
      new AuditService(prisma as never) as never,
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  function body(rangeType: string, overrides: Record<string, unknown> = {}) {
    return {
      ostomyType: 'ILEOSTOMY' as const,
      rangeType,
      minDaysPostOp: 0,
      maxDaysPostOp: 30,
      lowValue: 500,
      highValue: 1200,
      unit: 'mL',
      windowDays: null,
      ...overrides,
    } as never;
  }

  async function auditRowsFor(rangeId: string) {
    return prisma.auditEvent.findMany({
      where: { entityType: DEFAULT_RANGE_ENTITY_TYPE, entityId: rangeId },
      orderBy: { occurredAt: 'asc' },
    });
  }

  describe('the table starts empty, so this surface has to be able to fill it', () => {
    it('persists a created range', async () => {
      const write = await service.createDefaultRange(
        body('probe_created_ml'),
        ADMIN_SUBJECT,
        undefined,
      );

      const row = await prisma.clinicalDefaultRange.findUnique({ where: { id: write.rangeId } });
      expect(row).not.toBeNull();
      expect(row!.lowValue?.toNumber()).toBe(500);
      expect(row!.highValue?.toNumber()).toBe(1200);
      expect(row!.maxDaysPostOp).toBe(30);
    });

    it('records a CREATE with no before state and the admin identity', async () => {
      const write = await service.createDefaultRange(
        body('probe_audit_ml'),
        ADMIN_SUBJECT,
        undefined,
      );

      const rows = await auditRowsFor(write.rangeId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.action).toBe('CREATE');
      expect(rows[0]!.actorType).toBe('ADMIN');
      expect(rows[0]!.actorId).toBe(ADMIN_SUBJECT);
      expect(rows[0]!.reasonCode).toBe('admin_config_change');
      // Absent, not an empty object: a reader can tell a creation from a before state
      // that was not captured.
      expect(rows[0]!.beforeValue).toBeNull();
      expect(rows[0]!.afterValue).toMatchObject({ rangeType: 'probe_audit_ml', unit: 'mL' });
    });

    /**
     * The snapshot's completeness is why it carries the identity fields: `1200 -> 1400`
     * says nothing about which ostomy, which post-operative window, or what unit. An
     * exact key set rather than `toMatchObject`, which would pass while silently
     * dropping one — the field-drop failure CLAUDE.md records costing two sprints.
     */
    it('records every field of the snapshot', async () => {
      const write = await service.createDefaultRange(
        body('probe_snapshot_ml'),
        ADMIN_SUBJECT,
        undefined,
      );

      const rows = await auditRowsFor(write.rangeId);
      expect(Object.keys(rows[0]!.afterValue as object).sort()).toEqual([
        'highValue',
        'lowValue',
        'maxDaysPostOp',
        'minDaysPostOp',
        'ostomyType',
        'rangeType',
        'unit',
        'windowDays',
      ]);
    });

    it('records the correlation id when the request carries one', async () => {
      const write = await service.createDefaultRange(
        body('probe_correlated_ml'),
        ADMIN_SUBJECT,
        'request-abc',
      );

      expect((await auditRowsFor(write.rangeId))[0]!.correlationId).toBe('request-abc');
    });
  });

  /**
   * The invariant this surface exists to defend. Two rows matching one patient makes
   * §3.9 seed from whichever the query returned — a silent, retrospective ambiguity in
   * a clinical default.
   */
  describe('overlapping post-operative windows', () => {
    it('refuses a window that straddles an existing one', async () => {
      await service.createDefaultRange(
        body('probe_overlap_ml', { minDaysPostOp: 0, maxDaysPostOp: 30 }),
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(
        service.createDefaultRange(
          body('probe_overlap_ml', { minDaysPostOp: 15, maxDaysPostOp: 60 }),
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { error: { code: 'DEFAULT_RANGE_WINDOW_OVERLAPS' } },
      });
    });

    it('refuses a window that touches an existing one at a single day', async () => {
      // Both ends are inclusive, so a patient on day 30 would match both.
      await service.createDefaultRange(
        body('probe_touch_ml', { minDaysPostOp: 0, maxDaysPostOp: 30 }),
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(
        service.createDefaultRange(
          body('probe_touch_ml', { minDaysPostOp: 30, maxDaysPostOp: 60 }),
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({ status: 409 });
    });

    it('accepts adjacent windows that do not touch', async () => {
      await service.createDefaultRange(
        body('probe_adjacent_ml', { minDaysPostOp: 0, maxDaysPostOp: 30 }),
        ADMIN_SUBJECT,
        undefined,
      );

      const second = await service.createDefaultRange(
        body('probe_adjacent_ml', { minDaysPostOp: 31, maxDaysPostOp: null }),
        ADMIN_SUBJECT,
        undefined,
      );

      expect(second.range.minDaysPostOp).toBe(31);
    });

    /**
     * Scoped to the same ostomy type AND range type. Without that scoping the rule
     * would refuse every second row in the table, which is the opposite failure — the
     * table is designed to hold many rows per window.
     */
    it('allows the same window for a different range type', async () => {
      await service.createDefaultRange(body('probe_scope_a_ml'), ADMIN_SUBJECT, undefined);

      const other = await service.createDefaultRange(
        body('probe_scope_b_ml'),
        ADMIN_SUBJECT,
        undefined,
      );

      expect(other.range.rangeType).toBe('probe_scope_b_ml');
    });

    it('allows the same window for a different ostomy type', async () => {
      await service.createDefaultRange(body('probe_ostomy_ml'), ADMIN_SUBJECT, undefined);

      const other = await service.createDefaultRange(
        body('probe_ostomy_ml', { ostomyType: 'COLOSTOMY' }),
        ADMIN_SUBJECT,
        undefined,
      );

      expect(other.range.ostomyType).toBe('COLOSTOMY');
    });

    it('writes no row and no audit row when it refuses', async () => {
      await service.createDefaultRange(body('probe_refused_ml'), ADMIN_SUBJECT, undefined);
      const auditBefore = await prisma.auditEvent.count({
        where: { entityType: DEFAULT_RANGE_ENTITY_TYPE },
      });

      await expect(
        service.createDefaultRange(
          body('probe_refused_ml', { minDaysPostOp: 10, maxDaysPostOp: 20 }),
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toThrow();

      expect(
        await prisma.clinicalDefaultRange.count({ where: { rangeType: 'probe_refused_ml' } }),
      ).toBe(1);
      expect(
        await prisma.auditEvent.count({ where: { entityType: DEFAULT_RANGE_ENTITY_TYPE } }),
      ).toBe(auditBefore);
    });
  });

  describe('updating a range', () => {
    it('changes the bounds and leaves the identity alone', async () => {
      const created = await service.createDefaultRange(
        body('probe_update_ml'),
        ADMIN_SUBJECT,
        undefined,
      );

      await service.updateDefaultRange(
        created.rangeId,
        { lowValue: 400, highValue: 1100, windowDays: 7 },
        ADMIN_SUBJECT,
        undefined,
      );

      const row = await prisma.clinicalDefaultRange.findUnique({ where: { id: created.rangeId } });
      expect(row!.lowValue?.toNumber()).toBe(400);
      expect(row!.windowDays).toBe(7);
      // The identity fields are absent from the write and must stay put.
      expect(row!.rangeType).toBe('probe_update_ml');
      expect(row!.ostomyType).toBe('ILEOSTOMY');
      expect(row!.minDaysPostOp).toBe(0);
      expect(row!.maxDaysPostOp).toBe(30);
      expect(row!.unit).toBe('mL');
    });

    it('records both sides in one audit row', async () => {
      const created = await service.createDefaultRange(
        body('probe_update_audit_ml'),
        ADMIN_SUBJECT,
        undefined,
      );

      await service.updateDefaultRange(
        created.rangeId,
        { lowValue: 400, highValue: 1100, windowDays: null },
        ADMIN_SUBJECT,
        undefined,
      );

      const rows = await auditRowsFor(created.rangeId);
      expect(rows.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
      expect(rows[1]!.beforeValue).toMatchObject({ lowValue: 500 });
      expect(rows[1]!.afterValue).toMatchObject({ lowValue: 400 });
    });

    it('refuses a write whose row moved underneath it', async () => {
      const created = await service.createDefaultRange(
        body('probe_concurrent_ml'),
        ADMIN_SUBJECT,
        undefined,
      );
      const stale = (await prisma.clinicalDefaultRange.findUnique({
        where: { id: created.rangeId },
      }))!.updatedAt;

      await service.updateDefaultRange(
        created.rangeId,
        { lowValue: 400, highValue: 1100, windowDays: null },
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(
        service.updateDefaultRange(
          created.rangeId,
          { lowValue: 300, highValue: 1000, windowDays: null },
          ADMIN_SUBJECT,
          undefined,
          stale,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { error: { code: 'DEFAULT_RANGE_MODIFIED_CONCURRENTLY' } },
      });

      // The first change still governs, and the audit chain has no hole.
      const row = await prisma.clinicalDefaultRange.findUnique({ where: { id: created.rangeId } });
      expect(row!.lowValue?.toNumber()).toBe(400);
    });

    it('refuses an unknown id as a 404', async () => {
      await expect(
        service.updateDefaultRange(
          '00000000-0000-4000-8000-000000000000',
          { lowValue: 1, highValue: 2, windowDays: null },
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({
        status: 404,
        response: { error: { code: 'DEFAULT_RANGE_NOT_FOUND' } },
      });
    });
  });

  /**
   * The one admin surface with a real delete, because nothing references these rows: a
   * patient's effective range carries its own bounds with `CLINICAL_DEFAULT` provenance,
   * a copy rather than a pointer, and there is no foreign key from it to this table.
   */
  describe('deleting a range', () => {
    it('removes the row', async () => {
      const created = await service.createDefaultRange(
        body('probe_delete_ml'),
        ADMIN_SUBJECT,
        undefined,
      );

      await service.deleteDefaultRange(created.rangeId, ADMIN_SUBJECT, undefined);

      expect(
        await prisma.clinicalDefaultRange.findUnique({ where: { id: created.rangeId } }),
      ).toBeNull();
    });

    it('keeps what the row said, in an audit row with no after state', async () => {
      const created = await service.createDefaultRange(
        body('probe_delete_audit_ml'),
        ADMIN_SUBJECT,
        undefined,
      );

      await service.deleteDefaultRange(created.rangeId, ADMIN_SUBJECT, undefined);

      const rows = await auditRowsFor(created.rangeId);
      expect(rows.map((row) => row.action)).toEqual(['CREATE', 'DELETE']);
      // The inverse of a create, and after the delete the only place the row exists.
      expect(rows[1]!.beforeValue).toMatchObject({
        rangeType: 'probe_delete_audit_ml',
        lowValue: 500,
      });
      expect(rows[1]!.afterValue).toBeNull();
    });

    it('frees the window, so the corrected row can be created', async () => {
      // Why delete has to exist: the window is immutable, so delete-and-create is the
      // only correction path for a wrong one.
      const created = await service.createDefaultRange(
        body('probe_recreate_ml', { minDaysPostOp: 0, maxDaysPostOp: 30 }),
        ADMIN_SUBJECT,
        undefined,
      );
      await service.deleteDefaultRange(created.rangeId, ADMIN_SUBJECT, undefined);

      const replacement = await service.createDefaultRange(
        body('probe_recreate_ml', { minDaysPostOp: 0, maxDaysPostOp: 45 }),
        ADMIN_SUBJECT,
        undefined,
      );

      expect(replacement.range.maxDaysPostOp).toBe(45);
    });

    it('refuses an unknown id as a 404', async () => {
      await expect(
        service.deleteDefaultRange(
          '00000000-0000-4000-8000-000000000001',
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('the audit row and the change commit together', () => {
    it('passes the transaction client to the audit write', async () => {
      const received: unknown[] = [];
      const real = new AuditService(prisma as never);
      const spy = {
        record: async (context: unknown, tx?: unknown) => {
          received.push(tx);
          return real.record(context as never, tx as never);
        },
      };
      const spied = new AdminDefaultRangesService(prisma as never, spy as never);

      await spied.createDefaultRange(body('probe_tx_ml'), ADMIN_SUBJECT, undefined);

      expect(received).toHaveLength(1);
      // Identity is the discriminator: `this.prisma` would be referentially equal to
      // this client while a transaction client never is. `toBeDefined()` alone passed
      // twice in PR A with the guarantee removed.
      expect(received[0]).not.toBe(prisma);
    });

    it('creates no row when the audit write fails', async () => {
      const audit = {
        record: () => {
          throw new Error('audit unavailable');
        },
      };
      const brittle = new AdminDefaultRangesService(prisma as never, audit as never);

      await expect(
        brittle.createDefaultRange(body('probe_rollback_ml'), ADMIN_SUBJECT, undefined),
      ).rejects.toThrow();

      expect(
        await prisma.clinicalDefaultRange.count({ where: { rangeType: 'probe_rollback_ml' } }),
      ).toBe(0);
    });

    it('keeps the row when the audit write fails on a delete', async () => {
      // The direction that matters more: a delete whose audit row does not land would
      // destroy the only record of what the row said.
      const created = await service.createDefaultRange(
        body('probe_delete_rollback_ml'),
        ADMIN_SUBJECT,
        undefined,
      );
      const audit = {
        record: () => {
          throw new Error('audit unavailable');
        },
      };
      const brittle = new AdminDefaultRangesService(prisma as never, audit as never);

      await expect(
        brittle.deleteDefaultRange(created.rangeId, ADMIN_SUBJECT, undefined),
      ).rejects.toThrow();

      expect(
        await prisma.clinicalDefaultRange.findUnique({ where: { id: created.rangeId } }),
      ).not.toBeNull();
    });

    /** ADR-0011, on an ADMIN-actor row for a default range specifically. */
    it('cannot amend the audit row it just wrote', async () => {
      const write = await service.createDefaultRange(
        body('probe_immutable_audit_ml'),
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(
        prisma.auditEvent.update({
          where: { id: write.auditEventId },
          data: { afterValue: { lowValue: 0 } },
        }),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  it('publishes a body matching the contract the OpenAPI document declares', async () => {
    await service.createDefaultRange(body('probe_contract_ml'), ADMIN_SUBJECT, undefined);

    const listed = await service.listDefaultRanges();

    // Covers the Decimal to number projection, the ISO `updatedAt`, the uuid and the
    // ostomy-type enum in one assertion, and fails loudly if a Prisma `Decimal` leaks.
    expect(adminDefaultRangesResponseSchema.safeParse(listed).success).toBe(true);
  });
});
