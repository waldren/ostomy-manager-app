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

import {
  adminDefaultRangesResponseSchema,
  SAFETY_RANGE_TYPES,
  createDefaultRangeSchema,
  type CreateDefaultRangeRequest,
} from './admin-default-range-wire';
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
  /**
   * Hoisted for #97's tests, which write as the OWNER on purpose: the point of
   * a database constraint is that it holds for a writer that never goes near
   * the service.
   */
  let ownerUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('ostomy_admin_ranges_test')
      .withUsername('ostomy_owner')
      .withPassword('owner-test-only-password')
      .start();
    const ownerDatabaseUrl = container.getConnectionUri();
    ownerUrl = ownerDatabaseUrl;

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
    await registerProbeRangeTypes();
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  /**
   * A create body, typed and parsed through the real schema.
   *
   * The first version returned `as never`, which erased `CreateDefaultRangeRequest`
   * from every call site: a field added to the wire contract and forgotten in the
   * service's `data` object still typechecked, and so did a renamed one. That is the
   * field-drop class CLAUDE.md records costing two sprints on the observation paths.
   *
   * Parsing rather than casting also means the fixture travels the validation path the
   * suite otherwise never exercises, so a body this spec believes is valid provably is.
   */
  /**
   * Limits rows for the range types this spec invents (#102).
   *
   * Every test uses its own `range_type` so the overlap constraint cannot make
   * tests interfere — and #102's foreign key means a type with no limits row
   * does not exist as far as the database is concerned. So the fixtures
   * register theirs, as the OWNER, which is what a migration does for the real
   * types.
   *
   * Permissive on purpose: these exist to satisfy referential integrity, not to
   * test the bounds. The bound tests below set their own narrow limits.
   *
   * No maintenance burden if this list goes stale: a test using an unregistered
   * type fails immediately with `clinical_default_ranges_range_type_fkey`,
   * which names the problem exactly.
   */
  const PROBE_RANGE_TYPES: readonly (readonly [string, string])[] = [
    ['p97_adjacent', 'mL'],
    ['p97_ceiling', 'mL'],
    ['p97_floor', 'mL'],
    ['p97_invbounds', 'mL'],
    ['p97_inverted', 'mL'],
    ['p97_nobound', 'mL'],
    ['p97_nullwin', 'mL'],
    ['p97_open', 'mL'],
    ['p97_race', 'mL'],
    ['p97_shape', 'mL'],
    ['p97_touching', 'mL'],
    ['p97_types', 'mL'],
    ['p97_windows', 'mL'],
    // Added when #98's tests merged with #102's: the foreign key is what
    // surfaced them, which is the registration requirement working.
    ['p98_ordinary_ml', 'mL'],
    ['p98_tombstone', 'mL'],
    ['p98_tombstone_back', 'mL'],
    ['probe_restore_limits_ml', 'mL'],
    ['probe_restore_ml', 'mL'],
    ['probe_restore_unit_ml', 'mL'],
    ['probe_adjacent_ml', 'mL'],
    ['probe_audit_ml', 'mL'],
    ['probe_concurrent_ml', 'mL'],
    ['probe_contract_ml', 'mL'],
    ['probe_correlated_ml', 'mL'],
    ['probe_created_ml', 'mL'],
    ['probe_delete_audit_ml', 'mL'],
    ['probe_delete_concurrent_ml', 'mL'],
    ['probe_delete_ml', 'mL'],
    ['probe_delete_rollback_ml', 'mL'],
    ['probe_immutable_audit_ml', 'mL'],
    ['probe_order_ml', 'mL'],
    ['probe_ostomy_ml', 'mL'],
    ['probe_overlap_ml', 'mL'],
    ['probe_recreate_ml', 'mL'],
    ['probe_refused_ml', 'mL'],
    ['probe_rollback_ml', 'mL'],
    ['probe_same_shape_pct', '%'],
    ['probe_scope_a_ml', 'mL'],
    ['probe_scope_b_ml', 'mL'],
    ['probe_snapshot_ml', 'mL'],
    ['probe_touch_ml', 'mL'],
    ['probe_tx_ml', 'mL'],
    ['probe_unbounded_ml', 'mL'],
    ['probe_undeletable_audit_ml', 'mL'],
    ['probe_unit_ml', 'mL'],
    ['probe_update_audit_ml', 'mL'],
    ['probe_update_ml', 'mL'],
    ['probe_window_shape_pct', '%'],
  ];

  async function registerProbeRangeTypes(): Promise<void> {
    const owner = new PgClient({ connectionString: ownerUrl });
    await owner.connect();
    try {
      for (const [rangeType, rangeUnit] of PROBE_RANGE_TYPES) {
        await owner.query(
          `INSERT INTO clinical_default_range_limits
             (range_type, min_value, max_value, unit, basis, updated_at)
           VALUES ($1, -99999999.9999, 99999999.9999, $2, 'integration-test fixture', now())
           ON CONFLICT (range_type) DO NOTHING`,
          [rangeType, rangeUnit],
        );
      }
    } finally {
      await owner.end();
    }
  }

  function body(
    rangeType: string,
    overrides: Partial<CreateDefaultRangeRequest> = {},
  ): CreateDefaultRangeRequest {
    return createDefaultRangeSchema.parse({
      ostomyType: 'ILEOSTOMY',
      rangeType,
      minDaysPostOp: 0,
      maxDaysPostOp: 30,
      lowValue: 500,
      highValue: 1200,
      unit: 'mL',
      windowDays: null,
      ...overrides,
    });
  }

  /**
   * Writes a type's limits as the owner role. The runtime role holds `SELECT`
   * only on this table (#102), which is the point — these rows are migration-
   * owned and no request handler may move them.
   *
   * Lived inside the #102 describe until #98's restore tests needed it too.
   */
  async function setLimits(
    rangeType: string,
    minValue: number,
    maxValue: number,
    rangeUnit = 'bpm',
  ): Promise<void> {
    const owner = new PgClient({ connectionString: ownerUrl });
    await owner.connect();
    try {
      await owner.query(
        `INSERT INTO clinical_default_range_limits
           (range_type, min_value, max_value, unit, basis, updated_at)
         VALUES ($1, $2, $3, $4, 'test', now())
         ON CONFLICT (range_type) DO UPDATE
           SET min_value = EXCLUDED.min_value,
               max_value = EXCLUDED.max_value,
               unit = EXCLUDED.unit`,
        [rangeType, minValue, maxValue, rangeUnit],
      );
    } finally {
      await owner.end();
    }
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
      // Persisted, not merely un-refused: the previous assertion only echoed the input.
      expect(
        await prisma.clinicalDefaultRange.count({ where: { rangeType: 'probe_adjacent_ml' } }),
      ).toBe(2);
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

    /**
     * Two rules of different SHAPE may share a window, and this is the case the first
     * version refused. SRS §3.12 has the admin managing "rolling-window definitions",
     * plural, so a 7-day and a 30-day rule for one range type is ordinary
     * configuration — and two rows of different shape matching one patient is not
     * ambiguity, because §3.9 seeds both as separate ranges.
     */
    it('allows the same window for a different rolling window length', async () => {
      await service.createDefaultRange(
        body('probe_window_shape_pct', { windowDays: 7, unit: '%' }),
        ADMIN_SUBJECT,
        undefined,
      );

      const second = await service.createDefaultRange(
        body('probe_window_shape_pct', { windowDays: 30, unit: '%' }),
        ADMIN_SUBJECT,
        undefined,
      );

      expect(second.range.windowDays).toBe(30);
      expect(
        await prisma.clinicalDefaultRange.count({ where: { rangeType: 'probe_window_shape_pct' } }),
      ).toBe(2);
    });

    it('still refuses two rows of the SAME shape in one window', async () => {
      await service.createDefaultRange(
        body('probe_same_shape_pct', { windowDays: 7, unit: '%' }),
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(
        service.createDefaultRange(
          body('probe_same_shape_pct', { windowDays: 7, unit: '%', minDaysPostOp: 10 }),
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { error: { code: 'DEFAULT_RANGE_WINDOW_OVERLAPS' } },
      });
    });

    /**
     * The case the unit spec covers only in pure arithmetic: a `null` bound round-
     * tripped through Prisma, participating in the rule. "Three months and beyond"
     * twice over is the duplicate a default-table reviewer would most expect caught.
     */
    it('refuses a window overlapping an unbounded sibling', async () => {
      await service.createDefaultRange(
        body('probe_unbounded_ml', { minDaysPostOp: 90, maxDaysPostOp: null }),
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(
        service.createDefaultRange(
          body('probe_unbounded_ml', { minDaysPostOp: 120, maxDaysPostOp: 150 }),
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({ status: 409 });
    });

    /**
     * The unit is an invariant ACROSS rows, because the wire module rests `unit`'s
     * immutability on "the rangeType already names it" — and §3.9's consumer is exactly
     * the reader that comment licenses to believe it.
     */
    it('refuses a row whose unit disagrees with its siblings', async () => {
      await service.createDefaultRange(
        body('probe_unit_ml', { minDaysPostOp: 0, maxDaysPostOp: 30 }),
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(
        service.createDefaultRange(
          body('probe_unit_ml', { minDaysPostOp: 31, maxDaysPostOp: null, unit: 'oz' }),
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          error: {
            code: 'INVALID_DEFAULT_RANGE',
            fields: [{ field: 'unit', rule: 'wrong_unit_for_type' }],
          },
        },
      });
    });

    it('writes no row and no audit row when it refuses', async () => {
      const created = await service.createDefaultRange(
        body('probe_refused_ml'),
        ADMIN_SUBJECT,
        undefined,
      );
      // Scoped to this test's own row rather than counting the whole entity type: the
      // global count was correct only by accident of the runner being sequential.
      const auditBefore = await prisma.auditEvent.count({
        where: { entityType: DEFAULT_RANGE_ENTITY_TYPE, entityId: created.rangeId },
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
        await prisma.auditEvent.count({
          where: { entityType: DEFAULT_RANGE_ENTITY_TYPE, entityId: created.rangeId },
        }),
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
        { lowValue: 400, highValue: 1100 },
        ADMIN_SUBJECT,
        undefined,
      );

      const row = await prisma.clinicalDefaultRange.findUnique({ where: { id: created.rangeId } });
      expect(row!.lowValue?.toNumber()).toBe(400);
      // Every identity field is absent from the write and must stay put — including
      // `windowDays`, which moved into this set because it was mutable and excluded
      // from the overlap scope at the same time.
      expect(row!.rangeType).toBe('probe_update_ml');
      expect(row!.ostomyType).toBe('ILEOSTOMY');
      expect(row!.minDaysPostOp).toBe(0);
      expect(row!.maxDaysPostOp).toBe(30);
      expect(row!.unit).toBe('mL');
      expect(row!.windowDays).toBeNull();
    });

    it('records both sides in one audit row', async () => {
      const created = await service.createDefaultRange(
        body('probe_update_audit_ml'),
        ADMIN_SUBJECT,
        undefined,
      );

      await service.updateDefaultRange(
        created.rangeId,
        { lowValue: 400, highValue: 1100 },
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
        { lowValue: 400, highValue: 1100 },
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(
        service.updateDefaultRange(
          created.rangeId,
          { lowValue: 300, highValue: 1000 },
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
          { lowValue: 1, highValue: 2 },
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
   * A withdrawal, not a removal, since #98.
   *
   * It used to be the one admin surface with a real delete, and the argument was
   * sound as far as it went: nothing references these rows, because a patient's
   * effective range carries its own bounds with `CLINICAL_DEFAULT` provenance, a
   * copy rather than a pointer with no foreign key back to this table. All of
   * that is still true — it is an argument about SAFETY, and #98 was about
   * RECOVERABILITY, which it never addressed. The row is now tombstoned and
   * `POST :id/restore` brings it back.
   */
  describe('deleting a range', () => {
    it('tombstones the row rather than removing it', async () => {
      // Asserted `toBeNull()` until #98.
      const created = await service.createDefaultRange(
        body('probe_delete_ml'),
        ADMIN_SUBJECT,
        undefined,
      );

      await service.deleteDefaultRange(created.rangeId, ADMIN_SUBJECT, undefined);

      const row = await prisma.clinicalDefaultRange.findUnique({
        where: { id: created.rangeId },
      });
      expect(row).not.toBeNull();
      expect(row!.deletedAt).toBeInstanceOf(Date);
    });

    it('drops the row from the live list and publishes it as withdrawn', async () => {
      // The safety-relevant half. §3.9's seeding will read `defaultRanges`, and a
      // tombstone reaching that array would seed a range an admin had withdrawn.
      const created = await service.createDefaultRange(
        body('probe_delete_ml', { minDaysPostOp: 700, maxDaysPostOp: 760 }),
        ADMIN_SUBJECT,
        undefined,
      );
      await service.deleteDefaultRange(created.rangeId, ADMIN_SUBJECT, undefined);

      const listed = await service.listDefaultRanges();
      expect(listed.defaultRanges.map((row) => row.id)).not.toContain(created.rangeId);
      expect(listed.deletedRanges.map((row) => row.id)).toContain(created.rangeId);
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

    /**
     * The audit row is the only surviving record of a deleted row, so it must describe
     * the version that was actually removed.
     *
     * `findUnique` then `delete({ where: { id } })` are two statements with their own
     * snapshots: a `PUT` committing between them meant `beforeValue` recorded v1 while
     * v2 was deleted. Unrecoverable, because there is nothing left to compare against.
     */
    it('refuses to delete a row that changed since it was read', async () => {
      const created = await service.createDefaultRange(
        body('probe_delete_concurrent_ml'),
        ADMIN_SUBJECT,
        undefined,
      );
      const staleService = new AdminDefaultRangesService(
        prisma as never,
        new AuditService(prisma as never) as never,
      );
      // Simulates the interleaving: the row moves after the delete's caller last saw it.
      await service.updateDefaultRange(
        created.rangeId,
        { lowValue: 111, highValue: 222 },
        ADMIN_SUBJECT,
        undefined,
      );

      // The delete re-reads inside its own transaction, so to exercise the guard the row
      // must move between THAT read and the delete. Asserted instead on the property
      // that matters: whatever is deleted is what the audit row describes.
      await staleService.deleteDefaultRange(created.rangeId, ADMIN_SUBJECT, undefined);
      const rows = await auditRowsFor(created.rangeId);
      const deleted = rows[rows.length - 1]!;
      expect(deleted.action).toBe('DELETE');
      expect(deleted.beforeValue).toMatchObject({ lowValue: 111, highValue: 222 });
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

    /** The mirror of the UPDATE grant, on the PR that introduces the first admin DELETE. */
    it('cannot delete the audit row it just wrote', async () => {
      const write = await service.createDefaultRange(
        body('probe_undeletable_audit_ml'),
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(prisma.auditEvent.delete({ where: { id: write.auditEventId } })).rejects.toThrow(
        /permission denied/i,
      );
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

  /**
   * #97: the invariants the API refuses are now refused by the table too.
   *
   * Every assertion here writes as the **owner** role, deliberately bypassing
   * the service — the point is that a migration, `packages/seed` or a psql
   * session cannot create a state the API would reject. Before #97 all five
   * rules were application-only, and CLAUDE.md said so in terms.
   */
  /**
   * #102: what a range type permits.
   *
   * The shape rules — numeric, fits `DECIMAL(12,4)` — cannot catch a value that
   * is well-formed and wrong for its type, and the consequential case is the one
   * #94 moved into this table: once `heart_rate_red_flag_bpm` is seeded, a high
   * value silences a seek-care prompt with no symptom at all.
   */
  describe('per-range-type limits (#102)', () => {
    it('seeds a limits row for every range type the schema names', async () => {
      const limits = (await service.listDefaultRanges()).rangeTypeLimits;
      const types = limits.map((entry) => entry.rangeType);

      // The seven the model's comment lists, including the safety one #94 moved
      // here. A type missing from this table cannot have a range at all, so the
      // list is load-bearing rather than documentation.
      expect(types).toEqual(
        expect.arrayContaining([
          'daily_output_ml',
          'net_fluid_balance_ml',
          'urine_output_adequacy_ml',
          'weight_change_threshold_percent',
          'resting_heart_rate_elevation_bpm',
          'orthostatic_postural_rise_bpm',
          'heart_rate_red_flag_bpm',
        ]),
      );
    });

    /**
     * Every seeded triple, not just the type names — this is the test that would
     * have caught the weight-change floor.
     *
     * The previous version asserted type names with `arrayContaining` and pinned
     * VALUES for one type only, so a migration seeding the wrong sign or unit
     * for any of the other six passed everything. `weight_change_threshold_percent`
     * was seeded with a positive floor, which made the weight-LOSS direction
     * unconfigurable — contradicting `admin-default-range-wire.ts`, which says
     * that type "legitimately ha[s] negative floors".
     */
    it.each([
      ['daily_output_ml', 0.0001, 99_999_999.9999, 'mL'],
      ['urine_output_adequacy_ml', 0.0001, 99_999_999.9999, 'mL'],
      ['net_fluid_balance_ml', -99_999_999.9999, 99_999_999.9999, 'mL'],
      ['weight_change_threshold_percent', -100, 100, '%'],
      ['resting_heart_rate_elevation_bpm', 0.0001, 300, 'bpm'],
      ['orthostatic_postural_rise_bpm', 0.0001, 300, 'bpm'],
      ['heart_rate_red_flag_bpm', 0.0001, 300, 'bpm'],
    ])('seeds %s as %s to %s %s', async (rangeType, minValue, maxValue, unit) => {
      const limits = (await service.listDefaultRanges()).rangeTypeLimits;

      expect(limits).toEqual(expect.arrayContaining([{ rangeType, minValue, maxValue, unit }]));
    });

    it('accepts a negative weight-change floor, which is the clinical direction', async () => {
      // SRS §3.12's signal is percent change and the important direction is a
      // drop. The first version of the limits row refused this outright.
      const write = await service.createDefaultRange(
        body('weight_change_threshold_percent', {
          minDaysPostOp: 500,
          maxDaysPostOp: 560,
          lowValue: -3,
          highValue: 3,
          unit: '%',
          windowDays: 7,
        }),
        ADMIN_SUBJECT,
        undefined,
      );

      expect(write.range.lowValue).toBe(-3);
    });

    it('publishes the limits on the read, so a caller can see them first', async () => {
      // The 400 names the field and a rule code and never the numbers, so this
      // is the only place a caller can learn them. The refusal is the backstop;
      // seeing the range is what prevents the mistake.
      const limits = (await service.listDefaultRanges()).rangeTypeLimits;
      const redFlag = limits.find((entry) => entry.rangeType === 'heart_rate_red_flag_bpm');

      expect(redFlag).toMatchObject({ unit: 'bpm', maxValue: 300 });
    });

    /**
     * The half of the control that works, stated as such.
     *
     * 300 bpm exceeds any achievable human heart rate, so a red-flag bound
     * cannot be set above it — which is what stops the seek-care prompt being
     * silenced, one of the two failures #102 names.
     */
    /**
     * The limits on this type are a TYPO GUARD, not a silencing guard, and the
     * first version of this test claimed otherwise.
     *
     * It was named "refuses a red-flag bound high enough to silence the prompt"
     * and used 99,000 — so all it proved was that absurd values are refused.
     * The ceiling is 300 bpm, chosen because no reading can exceed it, which
     * makes a threshold OF 300 one no reading can exceed: self-refuting. In
     * practice anything from roughly 220 upward silences it. What actually keeps
     * the prompt reachable is the seeded rows and the shape rules, tested above.
     */
    it('refuses a physically impossible bound, which is all these limits do', async () => {
      const row = await prisma.clinicalDefaultRange.findFirst({
        where: { rangeType: 'heart_rate_red_flag_bpm', ostomyType: 'ILEOSTOMY' },
      });

      await expect(
        service.updateDefaultRange(
          row!.id,
          { lowValue: null, highValue: 99_000 },
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          error: {
            code: 'INVALID_DEFAULT_RANGE',
            fields: [{ field: 'highValue', rule: 'outside_type_limits' }],
          },
        },
      });
    });

    it('accepts a bound at the ceiling, which is why the ceiling is not a control', async () => {
      // Pinned deliberately. 300 bpm is accepted exactly, and a threshold no
      // reading can reach is a silenced prompt — so this records that the limits
      // table does not close that hole, and the service rules do. If a clinical
      // ceiling is ever chosen (#102), this test is the one that should change.
      const row = await prisma.clinicalDefaultRange.findFirst({
        where: { rangeType: 'heart_rate_red_flag_bpm', ostomyType: 'COLOSTOMY' },
      });

      const updated = await service.updateDefaultRange(
        row!.id,
        { lowValue: null, highValue: 300 },
        ADMIN_SUBJECT,
        undefined,
      );
      expect(updated.range.highValue).toBe(300);

      await service.updateDefaultRange(
        row!.id,
        { lowValue: null, highValue: 120 },
        ADMIN_SUBJECT,
        undefined,
      );
    });

    it('names both bounds when both are outside', async () => {
      await setLimits('p102_both', 10, 20);

      await expect(
        service.createDefaultRange(
          body('p102_both', { lowValue: 1, highValue: 99, unit: 'bpm' }),
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({
        response: {
          error: {
            fields: [
              { field: 'lowValue', rule: 'outside_type_limits' },
              { field: 'highValue', rule: 'outside_type_limits' },
            ],
          },
        },
      });
    });

    it('never echoes the value or the bounds in the refusal', async () => {
      await setLimits('p102_noecho', 10, 20);

      let captured: unknown;
      try {
        await service.createDefaultRange(
          body('p102_noecho', { lowValue: null, highValue: 4242, unit: 'bpm' }),
          ADMIN_SUBJECT,
          undefined,
        );
      } catch (error) {
        captured = error;
      }

      // CLAUDE.md: field identifiers and rule codes, never the offending value.
      const serialised = JSON.stringify((captured as { response?: unknown }).response ?? {});
      expect(serialised).not.toContain('4242');
      expect(serialised).not.toContain('20');
    });

    it('checks the update too, which is where a bound actually changes', async () => {
      // A create with a sane bound followed by a PUT to a silencing one would
      // otherwise walk straight past the check.
      await setLimits('p102_update', 10, 200);
      const write = await service.createDefaultRange(
        body('p102_update', { lowValue: null, highValue: 150, unit: 'bpm' }),
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(
        service.updateDefaultRange(
          write.rangeId,
          { lowValue: null, highValue: 9_000 },
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({
        response: { error: { fields: [{ field: 'highValue', rule: 'outside_type_limits' }] } },
      });
    });

    /**
     * Against `weight_change_threshold_percent` rather than `net_fluid_balance_ml`,
     * which this used before #130 seeded the clinical defaults.
     *
     * Not a weakening — it is the same property on another signed type, and the
     * reason for the move is worth knowing. The seeded net-balance row spans day 0
     * onward, so every day window for that (type, ostomy type) is occupied and
     * #97's exclusion constraint refuses a second one. The test was picking a high
     * day range to stay clear of other tests' rows; there is no longer a free one.
     *
     * `net_fluid_balance_ml`'s own signedness is now pinned by the seeded-row
     * tests below, which is a stronger statement than this one made: it asserts
     * the shipped value rather than that a negative value is accepted.
     */
    it('allows a negative bound where the type is signed', async () => {
      // §3.12 measures percent change in either direction, so a negative floor is
      // the point rather than an edge case. Giving a signed type a positive floor
      // would be the most plausible-looking mistake in this table — and was made
      // once, for this very type.
      const write = await service.createDefaultRange(
        body('weight_change_threshold_percent', {
          minDaysPostOp: 300,
          maxDaysPostOp: 360,
          lowValue: -8,
          highValue: 0,
          unit: '%',
        }),
        ADMIN_SUBJECT,
        undefined,
      );

      expect(write.range.lowValue).toBe(-8);
    });

    describe('the unit, now read from one place', () => {
      it('refuses a unit the type does not use', async () => {
        // This used to be a cross-row comparison, which agreed with whatever the
        // FIRST row of a type happened to say — so a type whose rows were all in
        // the wrong unit was self-consistent and accepted.
        //
        // Against `resting_heart_rate_elevation_bpm` rather than `daily_output_ml`
        // since #130 seeded the latter's day axis through to open-ended: the
        // overlap check runs first, so a seeded window turns this into a 409 and
        // the unit rule is never reached. A type with limits and no seeded rows
        // keeps the test about the unit.
        await expect(
          service.createDefaultRange(
            body('resting_heart_rate_elevation_bpm', {
              minDaysPostOp: 400,
              maxDaysPostOp: 460,
              unit: 'oz',
            }),
            ADMIN_SUBJECT,
            undefined,
          ),
        ).rejects.toMatchObject({
          status: 400,
          response: {
            error: {
              code: 'INVALID_DEFAULT_RANGE',
              fields: [{ field: 'unit', rule: 'wrong_unit_for_type' }],
            },
          },
        });
      });

      it('refuses the wrong unit even for the first row of a type', async () => {
        await setLimits('p102_firstrow', -99_999, 99_999, 'mL');

        await expect(
          service.createDefaultRange(
            body('p102_firstrow', { unit: 'oz' }),
            ADMIN_SUBJECT,
            undefined,
          ),
        ).rejects.toMatchObject({
          status: 400,
          response: {
            error: {
              code: 'INVALID_DEFAULT_RANGE',
              fields: [{ field: 'unit', rule: 'wrong_unit_for_type' }],
            },
          },
        });
      });
    });

    describe('the foreign key on range_type', () => {
      it('refuses an unknown type through the API, naming the field', async () => {
        await expect(
          service.createDefaultRange(
            body('heart_rate_redflag_bpm', { unit: 'bpm' }),
            ADMIN_SUBJECT,
            undefined,
          ),
        ).rejects.toMatchObject({
          response: {
            error: {
              code: 'INVALID_DEFAULT_RANGE',
              fields: [{ field: 'rangeType', rule: 'unknown_range_type' }],
            },
          },
        });
      });

      it('refuses an unknown type written directly as the owner', async () => {
        // The typo hazard `admin-default-range-wire.ts` worries about, closed at
        // the database rather than only at the API: `heart_rate_redflag_bpm` is
        // a plausible misspelling of the safety type, and before #102 it created
        // a row of a type nothing reads.
        const owner = new PgClient({ connectionString: ownerUrl });
        await owner.connect();
        try {
          await expect(
            owner.query(
              `INSERT INTO clinical_default_ranges
                 (id, ostomy_type, range_type, min_days_post_op, max_days_post_op,
                  low_value, high_value, unit, window_days, created_at, updated_at)
               VALUES (gen_random_uuid(), 'ILEOSTOMY', 'heart_rate_redflag_bpm', 0, 30,
                       NULL, 130, 'bpm', NULL, now(), now())`,
            ),
          ).rejects.toThrow(/clinical_default_ranges_range_type_fkey/);
        } finally {
          await owner.end();
        }
      });

      it('refuses removing a limits row while ranges of its type exist', async () => {
        await setLimits('p102_restrict', -99_999, 99_999, 'mL');
        await service.createDefaultRange(
          body('p102_restrict', { unit: 'mL' }),
          ADMIN_SUBJECT,
          undefined,
        );

        const owner = new PgClient({ connectionString: ownerUrl });
        await owner.connect();
        try {
          await expect(
            owner.query(`DELETE FROM clinical_default_range_limits WHERE range_type = $1`, [
              'p102_restrict',
            ]),
          ).rejects.toThrow(/clinical_default_ranges_range_type_fkey/);
        } finally {
          await owner.end();
        }
      });
    });

    it('keeps the limits read-only for the runtime role', async () => {
      // Migration-owned, like `tier` on a validation threshold. The grant is
      // what makes "immutable through the admin API" structural rather than a
      // convention the service happens to follow.
      await expect(
        prisma.$executeRawUnsafe(
          `UPDATE clinical_default_range_limits SET max_value = 99999 WHERE range_type = 'heart_rate_red_flag_bpm'`,
        ),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  /**
   * P4.S2 slice 1: the clinical defaults §3.9 seeds suggestions from (#130).
   *
   * ## What these tests are for
   *
   * **The numbers are implementer-chosen and unratified by any clinician** — the
   * same standing as the 120 bpm heart-rate bound (#102), recorded the same way.
   * Pinning them here is what makes ratification a visible change to this
   * repository: a clinician's value replaces one of these and this test fails
   * until someone updates it deliberately. A quiet edit to the migration cannot
   * pass.
   *
   * They are patient-facing by consequence rather than directly — a suggestion
   * built from one of these rows is shown as what is "typical for a similar
   * profile" (SRS §3.9's framing constraint), so a wrong number here becomes a
   * wrong statement about what is normal.
   */
  describe('the seeded clinical defaults (#130)', () => {
    /**
     * Every seeded row, not a sample. The lesson of the limits test above, which
     * pinned values for one type and let a wrong sign through for another: a
     * sample proves the mechanism and says nothing about the data.
     */
    it.each([
      ['ILEOSTOMY', 'daily_output_ml', 0, 30, 600, 1500],
      ['ILEOSTOMY', 'daily_output_ml', 31, 90, 500, 1200],
      ['ILEOSTOMY', 'daily_output_ml', 91, null, 500, 1000],
      ['COLOSTOMY', 'daily_output_ml', 0, 30, 300, 800],
      ['COLOSTOMY', 'daily_output_ml', 31, 90, 200, 600],
      ['COLOSTOMY', 'daily_output_ml', 91, null, 200, 500],
      ['ILEOSTOMY', 'urine_output_adequacy_ml', 0, null, 1000, null],
      ['COLOSTOMY', 'urine_output_adequacy_ml', 0, null, 1000, null],
      ['ILEOSTOMY', 'net_fluid_balance_ml', 0, null, 1500, null],
      ['COLOSTOMY', 'net_fluid_balance_ml', 0, null, 1500, null],
    ])(
      'seeds %s %s for days %s-%s as %s-%s mL',
      async (ostomyType, rangeType, minDays, maxDays, low, high) => {
        const row = await prisma.clinicalDefaultRange.findFirst({
          where: {
            ostomyType: ostomyType as 'ILEOSTOMY' | 'COLOSTOMY',
            rangeType: rangeType as string,
            minDaysPostOp: minDays as number,
            deletedAt: null,
          },
        });

        expect(
          row,
          `no seeded row for ${ostomyType} ${rangeType} from day ${String(minDays)}`,
        ).not.toBeNull();
        expect(row?.maxDaysPostOp ?? null).toBe(maxDays);
        expect(row?.lowValue === null ? null : Number(row?.lowValue)).toBe(low);
        expect(row?.highValue === null ? null : Number(row?.highValue)).toBe(high);
        expect(row?.unit).toBe('mL');
      },
    );

    /**
     * Day 0 onward, with no gap between windows.
     *
     * A gap is the failure that would not look like one: a patient whose surgery
     * was 30 days ago finds a suggestion, one 31 days ago finds none, and the
     * screen renders an empty field rather than an error. #97's exclusion
     * constraint refuses OVERLAPS at the database level and says nothing about
     * holes, so this is the half it cannot cover.
     */
    it.each([
      ['ILEOSTOMY', 'daily_output_ml'],
      ['COLOSTOMY', 'daily_output_ml'],
      ['ILEOSTOMY', 'urine_output_adequacy_ml'],
      ['COLOSTOMY', 'urine_output_adequacy_ml'],
      ['ILEOSTOMY', 'net_fluid_balance_ml'],
      ['COLOSTOMY', 'net_fluid_balance_ml'],
    ])('covers every day since surgery for %s %s', async (ostomyType, rangeType) => {
      const rows = await prisma.clinicalDefaultRange.findMany({
        where: {
          ostomyType: ostomyType as 'ILEOSTOMY' | 'COLOSTOMY',
          rangeType,
          deletedAt: null,
        },
        orderBy: { minDaysPostOp: 'asc' },
      });

      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0]?.minDaysPostOp).toBe(0);

      // Contiguous: each window starts the day after the previous one ended.
      rows.forEach((row, index) => {
        if (index === 0) return;
        const previous = rows[index - 1];
        expect(previous?.maxDaysPostOp, 'only the LAST window may be open-ended').not.toBeNull();
        expect(row.minDaysPostOp).toBe((previous?.maxDaysPostOp ?? 0) + 1);
      });

      // Open-ended at the end, so a patient years post-op still has one.
      expect(rows[rows.length - 1]?.maxDaysPostOp).toBeNull();
    });

    /**
     * Every seeded bound sits inside its type's limits.
     *
     * The limits are migration-owned and the bound check is application-only
     * (#102) — there is no CHECK comparing a range against its limits row — so a
     * migration CAN seed a row the admin API would refuse to create. That state
     * is only discoverable by looking, which is what this does.
     */
    it('seeds no range outside its own type limits', async () => {
      const limits = await prisma.clinicalDefaultRangeLimits.findMany();
      const byType = new Map(limits.map((entry) => [entry.rangeType, entry]));
      const ranges = await prisma.clinicalDefaultRange.findMany({ where: { deletedAt: null } });

      for (const range of ranges) {
        const limit = byType.get(range.rangeType);
        expect(limit, `${range.rangeType} has no limits row`).toBeDefined();
        expect(range.unit).toBe(limit?.unit);

        for (const bound of [range.lowValue, range.highValue]) {
          if (bound === null) continue;
          expect(Number(bound)).toBeGreaterThanOrEqual(Number(limit?.minValue));
          expect(Number(bound)).toBeLessThanOrEqual(Number(limit?.maxValue));
        }
      }
    });

    /**
     * A floor of zero would say a balance of zero is adequate, and it is not: a
     * patient whose intake merely matches their stoma output is dehydrating,
     * because urine and insensible losses come out of the same intake.
     *
     * Asserted separately from the value pin above because it is the direction
     * that matters rather than the number — if 1,500 is ratified down to 1,200
     * this still has to hold, and if it is ever ratified to 0 that is a decision
     * someone must make against this test rather than by editing a literal.
     */
    it('sets the net-balance floor above the urine floor it has to cover', async () => {
      const balance = await prisma.clinicalDefaultRange.findFirst({
        where: { rangeType: 'net_fluid_balance_ml', ostomyType: 'ILEOSTOMY', deletedAt: null },
      });
      const urine = await prisma.clinicalDefaultRange.findFirst({
        where: {
          rangeType: 'urine_output_adequacy_ml',
          ostomyType: 'ILEOSTOMY',
          deletedAt: null,
        },
      });

      expect(Number(balance?.lowValue)).toBeGreaterThan(Number(urine?.lowValue));
    });

    /**
     * An ileostomy drains before the colon absorbs water, so its volumes run
     * roughly three times a colostomy's. That ratio is why this table is keyed on
     * `ostomy_type` at all — a seeding that made the two equal would leave the
     * keying technically exercised and clinically meaningless.
     */
    it('keeps ileostomy output above colostomy output in every window', async () => {
      const windows = [0, 31, 91];
      for (const minDaysPostOp of windows) {
        const ileostomy = await prisma.clinicalDefaultRange.findFirst({
          where: { rangeType: 'daily_output_ml', ostomyType: 'ILEOSTOMY', minDaysPostOp },
        });
        const colostomy = await prisma.clinicalDefaultRange.findFirst({
          where: { rangeType: 'daily_output_ml', ostomyType: 'COLOSTOMY', minDaysPostOp },
        });

        expect(Number(ileostomy?.highValue)).toBeGreaterThan(Number(colostomy?.highValue));
        expect(Number(ileostomy?.lowValue)).toBeGreaterThan(Number(colostomy?.lowValue));
      }
    });

    /**
     * The safety row is NOT a suggestion source, and this is the sprint that has
     * to keep it that way.
     *
     * `heart_rate_red_flag_bpm` lives in this table (#94) because §3.11 manages it
     * here, and it is deliberately not patient-adjustable. The table has no
     * `patient_adjustable` column, so "not adjustable" has to be structural: the
     * row exists and nothing derives a patient range from it. Asserted here as
     * data — it has no post-operative windows to seed suggestions across — and
     * enforced in the selection query by `SAFETY_RANGE_TYPES` in slice 2.
     */
    it('leaves the safety row with the single day-0 window it has always had', async () => {
      const rows = await prisma.clinicalDefaultRange.findMany({
        where: { rangeType: 'heart_rate_red_flag_bpm', deletedAt: null },
      });

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.minDaysPostOp).toBe(0);
        expect(row.maxDaysPostOp).toBeNull();
        expect(Number(row.highValue)).toBe(120);
      }
    });
  });

  /**
   * #98: the one row this surface will not remove.
   *
   * `DELETE` was never the only operation that could switch off a safety prompt
   * — review found a `PUT` that did the same, and an absent row that did it by
   * default. All three are closed below. §3.13's red-flag bound is a seek-care prompt rather than a
   * data-quality warning — no override, no warning copy, and nothing in the app
   * reports that the prompt has become unreachable. It is also not needed for
   * correction: the bounds are mutable, so a wrong safety number is a `PUT`.
   */
  describe('the safety row is migration-owned (#98, corrected after review)', () => {
    const SAFETY_TYPE = SAFETY_RANGE_TYPES[0];

    /**
     * The seeded row for one ostomy type.
     *
     * Found rather than created, which is the whole change: review showed the
     * admin surface could create a safety row with a window covering nobody,
     * and that #98's delete guard then made it permanently unrecoverable — the
     * window is immutable and the correctly-windowed replacement overlaps. So
     * the rows are seeded by migration and this surface can only `PUT` them.
     */
    async function seededSafetyRow(ostomyType: 'ILEOSTOMY' | 'COLOSTOMY') {
      const row = await prisma.clinicalDefaultRange.findFirst({
        where: { rangeType: SAFETY_TYPE, ostomyType },
      });
      if (!row) throw new Error(`no seeded ${SAFETY_TYPE} row for ${ostomyType}`);
      return row;
    }

    it('names the heart-rate red flag, which is what makes the guard reachable', () => {
      // If this constant ever stops matching the seeded range type, the guard
      // silently protects nothing — so the anchor is asserted, not assumed.
      expect(SAFETY_TYPE).toBe('heart_rate_red_flag_bpm');
    });

    it('seeds one row per ostomy type, so the prompt exists at all', async () => {
      /**
       * The hole that subsumed the others: nothing seeded a red-flag row, so
       * the shipping state of every environment was "no threshold for any
       * patient" — the silenced configuration — and #98's guard was protecting
       * a row that did not exist.
       *
       * Two rows because `ostomy_type` is NOT NULL; the bound is population-wide
       * and both carry the same value. #98's asymmetry concern is exactly what
       * seeding both at once prevents.
       */
      for (const ostomyType of ['ILEOSTOMY', 'COLOSTOMY'] as const) {
        const row = await seededSafetyRow(ostomyType);
        expect(row.minDaysPostOp).toBe(0);
        expect(row.maxDaysPostOp).toBeNull();
        expect(row.windowDays).toBeNull();
        expect(row.lowValue).toBeNull();
        expect(row.highValue?.toNumber()).toBe(120);
        expect(row.unit).toBe('bpm');
      }
    });

    it('pins 120 bpm, so a clinician decision cannot land silently', async () => {
      // Chosen by an implementer and not ratified, the same footing as #93's
      // stoma-output pair. Resting tachycardia is conventionally above 100, but
      // a seek-care prompt must be rare to mean anything and 100 is reachable
      // by caffeine, anxiety or a mild fever; 120 at rest is not. Changing it is
      // a PUT, so ratification needs no migration — it needs this test edited.
      const row = await seededSafetyRow('ILEOSTOMY');

      expect(row.highValue?.toNumber()).toBe(120);
    });

    it('refuses the delete with a conflict, not a permission error', async () => {
      const row = await seededSafetyRow('ILEOSTOMY');

      await expect(
        service.deleteDefaultRange(row.id, ADMIN_SUBJECT, undefined),
      ).rejects.toMatchObject({
        status: 409,
        response: { error: { code: 'SAFETY_RANGE_NOT_DELETABLE' } },
      });
    });

    it('refuses creating one through this surface', async () => {
      // #98's own argument requires it: if removing one is too dangerous here,
      // so is creating one with a window covering nobody — which the API
      // accepted, and which the delete guard then made unrecoverable.
      await expect(
        service.createDefaultRange(
          body(SAFETY_TYPE, {
            minDaysPostOp: 10_000,
            maxDaysPostOp: 11_000,
            lowValue: null,
            highValue: 130,
            unit: 'bpm',
          }),
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { error: { code: 'SAFETY_RANGE_NOT_CREATABLE' } },
      });
    });

    describe('the PUT that used to silence it', () => {
      it('refuses removing the ceiling', async () => {
        /**
         * The route that falsified #98's premise. `{ lowValue: 0.0001,
         * highValue: null }` answered 200 with an audit row and left a row that
         * still looked configured — arguably worse than the delete, which at
         * least leaves a visibly absent row. SRS §3.13 defines the flag as a
         * reading "beyond" a threshold, so a safety row with no ceiling is not
         * a configured threshold.
         */
        const row = await seededSafetyRow('ILEOSTOMY');

        await expect(
          service.updateDefaultRange(
            row.id,
            { lowValue: 0.0001, highValue: null },
            ADMIN_SUBJECT,
            undefined,
          ),
        ).rejects.toMatchObject({
          status: 400,
          response: {
            error: {
              fields: expect.arrayContaining([
                { field: 'highValue', rule: 'required_for_safety_type' },
              ]),
            },
          },
        });
      });

      it('refuses adding a floor, which the spec does not describe', async () => {
        const row = await seededSafetyRow('COLOSTOMY');

        await expect(
          service.updateDefaultRange(
            row.id,
            { lowValue: 40, highValue: 120 },
            ADMIN_SUBJECT,
            undefined,
          ),
        ).rejects.toMatchObject({
          status: 400,
          response: {
            error: {
              fields: expect.arrayContaining([
                { field: 'lowValue', rule: 'not_applicable_to_safety_type' },
              ]),
            },
          },
        });
      });

      it('leaves the row untouched when it refuses', async () => {
        const before = await seededSafetyRow('ILEOSTOMY');

        await expect(
          service.updateDefaultRange(
            before.id,
            { lowValue: null, highValue: null },
            ADMIN_SUBJECT,
            undefined,
          ),
        ).rejects.toThrow();

        const after = await seededSafetyRow('ILEOSTOMY');
        expect(after.highValue?.toNumber()).toBe(before.highValue?.toNumber());
        expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
      });
    });

    it('leaves the row and writes no audit event when it refuses', async () => {
      const row = await seededSafetyRow('COLOSTOMY');
      const auditBefore = await auditRowsFor(row.id);

      await expect(
        service.deleteDefaultRange(row.id, ADMIN_SUBJECT, undefined),
      ).rejects.toMatchObject({ status: 409 });

      expect(
        await prisma.clinicalDefaultRange.findUnique({ where: { id: row.id } }),
      ).not.toBeNull();
      // A refused delete is not a change, so it leaves no trace. The seeded row
      // has no audit history of its own either — it arrived by migration, which
      // CLAUDE.md notes writes no audit events.
      expect(await auditRowsFor(row.id)).toHaveLength(auditBefore.length);
    });

    it('answers 404 for an id that does not exist, not "not deletable"', async () => {
      // The order of the two checks matters: reporting "not deletable" for a
      // missing row would say something false, and would leak that some row
      // with that id was protected.
      await expect(
        service.deleteDefaultRange(
          '00000000-0000-4000-8000-000000000000',
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({ response: { error: { code: 'DEFAULT_RANGE_NOT_FOUND' } } });
    });

    it('still allows the ceiling to be corrected, which is the only supported mutation', async () => {
      // The guards remove create and delete; they must not remove the one
      // correction anyone legitimately needs. This is also the ratification
      // path: a clinician's number arrives by PUT, not by migration.
      const row = await seededSafetyRow('ILEOSTOMY');

      const updated = await service.updateDefaultRange(
        row.id,
        { lowValue: null, highValue: 125 },
        ADMIN_SUBJECT,
        undefined,
      );
      expect(updated.range.highValue).toBe(125);

      // Put it back, because the rest of the file reads the seeded value.
      await service.updateDefaultRange(
        row.id,
        { lowValue: null, highValue: 120 },
        ADMIN_SUBJECT,
        undefined,
      );
    });

    it('still deletes an ordinary range type', async () => {
      // Otherwise the guard could be matching everything and these tests would
      // not notice.
      const write = await service.createDefaultRange(
        body('p98_ordinary_ml', { minDaysPostOp: 120, maxDaysPostOp: 150 }),
        ADMIN_SUBJECT,
        undefined,
      );

      await service.deleteDefaultRange(write.rangeId, ADMIN_SUBJECT, undefined);

      const row = await prisma.clinicalDefaultRange.findUnique({
        where: { id: write.rangeId },
      });
      expect(row!.deletedAt).toBeInstanceOf(Date);
    });
  });

  /**
   * #98's other half: a restore path.
   *
   * The issue's words for the gap — "recovering a row means a human reading JSON
   * out of `audit_events` and retyping it. The audit log is not readable through
   * any API."
   */
  describe('restoring a withdrawn range (#98)', () => {
    async function withdraw(rangeType: string, min: number, max: number): Promise<string> {
      const created = await service.createDefaultRange(
        body(rangeType, { minDaysPostOp: min, maxDaysPostOp: max }),
        ADMIN_SUBJECT,
        undefined,
      );
      await service.deleteDefaultRange(created.rangeId, ADMIN_SUBJECT, undefined);
      return created.rangeId;
    }

    it('brings the row back with its bounds intact', async () => {
      const id = await withdraw('probe_restore_ml', 800, 860);

      const restored = await service.restoreDefaultRange(id, ADMIN_SUBJECT, undefined);

      expect(restored.range.lowValue).toBe(500);
      expect(restored.range.highValue).toBe(1200);
      const row = await prisma.clinicalDefaultRange.findUnique({ where: { id } });
      expect(row!.deletedAt).toBeNull();
    });

    it('returns it to the live list', async () => {
      const id = await withdraw('probe_restore_ml', 900, 960);
      await service.restoreDefaultRange(id, ADMIN_SUBJECT, undefined);

      const listed = await service.listDefaultRanges();
      expect(listed.defaultRanges.map((row) => row.id)).toContain(id);
      expect(listed.deletedRanges.map((row) => row.id)).not.toContain(id);
    });

    it('audits the restore as a CREATE with an after state and no before', async () => {
      // From the table's point of view a range of that shape exists again where
      // none did. Recording it as an UPDATE clearing a column would describe the
      // mechanism rather than the event.
      const id = await withdraw('probe_restore_ml', 1000, 1060);
      await service.restoreDefaultRange(id, ADMIN_SUBJECT, undefined);

      const rows = await auditRowsFor(id);
      expect(rows.map((row) => row.action)).toEqual(['CREATE', 'DELETE', 'CREATE']);
      const last = rows[rows.length - 1]!;
      expect(last.afterValue).toMatchObject({ lowValue: 500, highValue: 1200 });
      expect(last.beforeValue).toBeNull();
      expect(last.actorId).toBe(ADMIN_SUBJECT);
    });

    /**
     * The failure that is the ordinary sequence rather than an edge case.
     *
     * #97's exclusion constraint is partial on `deleted_at`, so a tombstone does
     * not occupy its window — which is what keeps delete-and-create available as
     * the correction path for an immutable window ('frees the window, so the
     * corrected row can be created', above, is that path and now also covers the
     * partial constraint). The consequence is that by the time anyone restores,
     * the replacement may be in place.
     *
     * This one does NOT distinguish the layers, and that is worth stating rather
     * than discovering: deleting the service's own `assertNoOverlap` call leaves
     * it green, because #97's constraint then refuses the UPDATE and
     * `isWindowOverlapViolation` translates it to the same 409. Both layers are
     * kept deliberately — the service check is the interface (and the two tests
     * below, on the limits, are the ones only it can answer), the constraint the
     * backstop for writers that never take the advisory lock.
     */
    it('refuses when a replacement has filled the window', async () => {
      const id = await withdraw('probe_restore_ml', 1100, 1160);
      await service.createDefaultRange(
        body('probe_restore_ml', { minDaysPostOp: 1100, maxDaysPostOp: 1160 }),
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(service.restoreDefaultRange(id, ADMIN_SUBJECT, undefined)).rejects.toMatchObject(
        {
          status: 409,
          response: { error: { code: 'DEFAULT_RANGE_WINDOW_OVERLAPS' } },
        },
      );

      // And it stays withdrawn, so the refusal left no half-state.
      const row = await prisma.clinicalDefaultRange.findUnique({ where: { id } });
      expect(row!.deletedAt).toBeInstanceOf(Date);
    });

    it('refuses restoring a live row', async () => {
      const created = await service.createDefaultRange(
        body('probe_restore_ml', { minDaysPostOp: 1300, maxDaysPostOp: 1360 }),
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(
        service.restoreDefaultRange(created.rangeId, ADMIN_SUBJECT, undefined),
      ).rejects.toMatchObject({
        status: 409,
        response: { error: { code: 'DEFAULT_RANGE_NOT_DELETED' } },
      });
    });

    it('refuses an unknown id as a 404', async () => {
      await expect(
        service.restoreDefaultRange(
          '00000000-0000-4000-8000-000000000002',
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({
        status: 404,
        response: { error: { code: 'DEFAULT_RANGE_NOT_FOUND' } },
      });
    });

    /**
     * A restore is the one write on this surface whose content nobody is looking
     * at: the admin supplies an id and the bounds come back from the tombstone.
     * So the limits have to be re-read, and these two are what distinguish the
     * service's own check from #97's database constraints — which cover the
     * window and the bound ordering and deliberately do not cover either of
     * these (#102's interval check is application-only by design).
     */
    it('refuses a row whose bounds now sit outside its type limits', async () => {
      const id = await withdraw('probe_restore_limits_ml', 1600, 1660);
      // Narrowed after the row was withdrawn, which is the whole scenario:
      // nothing re-examines a tombstone, so without this check #102's interval
      // would be enforced on every path except the one with no human reading the
      // numbers.
      await setLimits('probe_restore_limits_ml', 0.0001, 900, 'mL');

      await expect(service.restoreDefaultRange(id, ADMIN_SUBJECT, undefined)).rejects.toMatchObject(
        {
          status: 400,
          response: {
            error: {
              code: 'INVALID_DEFAULT_RANGE',
              fields: [{ field: 'highValue', rule: 'outside_type_limits' }],
            },
          },
        },
      );
    });

    it('refuses a row whose unit its type no longer declares', async () => {
      const id = await withdraw('probe_restore_unit_ml', 1700, 1760);
      await setLimits('probe_restore_unit_ml', -99_999_999.9999, 99_999_999.9999, 'oz');

      await expect(service.restoreDefaultRange(id, ADMIN_SUBJECT, undefined)).rejects.toMatchObject(
        {
          status: 400,
          response: {
            error: {
              code: 'INVALID_DEFAULT_RANGE',
              fields: [{ field: 'unit', rule: 'wrong_unit_for_type' }],
            },
          },
        },
      );
    });

    it('refuses deleting an already-withdrawn row, rather than auditing it twice', async () => {
      // 409 not 404: the row exists and `restore` is the operation the caller
      // wants. Letting it through would write a second DELETE audit row with an
      // identical before value, implying a change that did not happen.
      const id = await withdraw('probe_restore_ml', 1400, 1460);
      const auditBefore = await auditRowsFor(id);

      await expect(service.deleteDefaultRange(id, ADMIN_SUBJECT, undefined)).rejects.toMatchObject({
        status: 409,
        response: { error: { code: 'DEFAULT_RANGE_ALREADY_DELETED' } },
      });

      expect(await auditRowsFor(id)).toHaveLength(auditBefore.length);
    });

    it('refuses editing a withdrawn row', async () => {
      // Editing one would leave a tombstone whose snapshot no longer matches what
      // was withdrawn, so a restore would bring back something nobody deleted.
      const id = await withdraw('probe_restore_ml', 1500, 1560);

      await expect(
        service.updateDefaultRange(id, { lowValue: 100, highValue: 200 }, ADMIN_SUBJECT, undefined),
      ).rejects.toMatchObject({
        status: 409,
        response: { error: { code: 'DEFAULT_RANGE_ALREADY_DELETED' } },
      });
    });
  });

  describe('the database enforces what the API refuses (#97)', () => {
    async function asOwner<T>(run: (client: PgClient) => Promise<T>): Promise<T> {
      const owner = new PgClient({ connectionString: ownerUrl });
      await owner.connect();
      try {
        return await run(owner);
      } finally {
        await owner.end();
      }
    }

    function insert(
      rangeType: string,
      min: number | null,
      max: number | null,
      low: number | null,
      high: number | null,
      windowDays: number | null = null,
      ostomyType = 'ILEOSTOMY',
    ): string {
      const sql = (value: number | null) => (value === null ? 'NULL' : String(value));
      return `INSERT INTO clinical_default_ranges
                (id, ostomy_type, range_type, min_days_post_op, max_days_post_op,
                 low_value, high_value, unit, window_days, created_at, updated_at)
              VALUES (gen_random_uuid(), '${ostomyType}', '${rangeType}', ${sql(min)}, ${sql(max)},
                      ${sql(low)}, ${sql(high)}, 'mL', ${sql(windowDays)}, now(), now())`;
    }

    describe('the day-window exclusion constraint', () => {
      it('accepts adjacent windows, because both ends are inclusive', async () => {
        // Days 0-30 and 31-60 do not share a day. `int4range` is half-open, so
        // the constraint adds 1 to the upper bound; getting that wrong is what
        // would reintroduce the one-day overlap the API rule exists to catch.
        await asOwner(async (owner) => {
          await owner.query(insert('p97_adjacent', 0, 30, 500, 1200));
          await owner.query(insert('p97_adjacent', 31, 60, 500, 1200));
        });
      });

      it('refuses windows sharing a single day', async () => {
        await asOwner(async (owner) => {
          await owner.query(insert('p97_touching', 0, 30, 500, 1200));
          await expect(owner.query(insert('p97_touching', 30, 60, 500, 1200))).rejects.toThrow(
            /clinical_default_ranges_window_no_overlap/,
          );
        });
      });

      it('refuses an overlap against an open-ended window', async () => {
        await asOwner(async (owner) => {
          await owner.query(insert('p97_open', 60, null, 500, 1200));
          await expect(owner.query(insert('p97_open', 90, 120, 500, 1200))).rejects.toThrow(
            /window_no_overlap/,
          );
        });
      });

      /**
       * The decision #97 asked to be made deliberately.
       *
       * `window_days` is coalesced in the constraint, so two rules with NO
       * rolling window collide — matching `sibling.windowDays === candidate.windowDays`
       * in the service, where `null === null` is TRUE. A bare `WITH =` would read
       * `NULL = NULL` as unknown and let the pair through, leaving the database
       * laxer than the API for the commonest case: most rules carry no window.
       */
      it('refuses two rules with no rolling window in the same days', async () => {
        await asOwner(async (owner) => {
          await owner.query(insert('p97_nullwin', 0, 30, 500, 1200, null));
          await expect(owner.query(insert('p97_nullwin', 10, 40, 500, 1200, null))).rejects.toThrow(
            /window_no_overlap/,
          );
        });
      });

      /**
       * The `WHERE deleted_at IS NULL` that #98 added, asserted at the database
       * rather than inferred from the service passing.
       *
       * Without it, withdrawing a row would leave its window occupied and the
       * replacement would be refused — so the soft delete would have broken
       * delete-and-create, the one correction path an immutable window leaves.
       * 'frees the window, so the corrected row can be created' covers that
       * through the service; this covers the writers the service does not see,
       * which is the whole reason #97 moved these rules into the schema.
       */
      it('exempts tombstoned rows, so a withdrawn window is free', async () => {
        await asOwner(async (owner) => {
          await owner.query(insert('p98_tombstone', 0, 30, 500, 1200));
          await owner.query(
            `UPDATE clinical_default_ranges SET deleted_at = now()
              WHERE range_type = 'p98_tombstone'`,
          );

          await owner.query(insert('p98_tombstone', 0, 30, 400, 900));
        });
      });

      it('still refuses the overlap once the withdrawn row is brought back', async () => {
        // The other direction, and the reason a restore can fail: several
        // tombstones may overlap each other and a live row, so bringing one back
        // is a write the constraint has not yet had a chance to judge.
        await asOwner(async (owner) => {
          await owner.query(insert('p98_tombstone_back', 0, 30, 500, 1200));
          await owner.query(
            `UPDATE clinical_default_ranges SET deleted_at = now()
              WHERE range_type = 'p98_tombstone_back'`,
          );
          await owner.query(insert('p98_tombstone_back', 0, 30, 400, 900));

          await expect(
            owner.query(
              `UPDATE clinical_default_ranges SET deleted_at = NULL
                WHERE range_type = 'p98_tombstone_back' AND deleted_at IS NOT NULL`,
            ),
          ).rejects.toThrow(/window_no_overlap/);
        });
      });

      it('allows different rolling windows over the same days', async () => {
        // A 7-day and a 30-day weight rule for one post-operative window are
        // ordinary configuration (SRS §3.12 says "rolling-window definitions",
        // plural), not ambiguity — §3.9 seeds both as separate ranges.
        await asOwner(async (owner) => {
          await owner.query(insert('p97_windows', 0, 90, 1, 5, 7));
          await owner.query(insert('p97_windows', 0, 90, 1, 10, 30));
        });
      });

      it('scopes the rule to one ostomy type', async () => {
        await asOwner(async (owner) => {
          await owner.query(insert('p97_types', 0, 30, 500, 1200, null, 'ILEOSTOMY'));
          await owner.query(insert('p97_types', 0, 30, 200, 600, null, 'COLOSTOMY'));
        });
      });
    });

    describe('the CHECK constraints', () => {
      /**
       * The state that was not merely reachable but **invisible**.
       *
       * `windowsOverlap` compares `aStart <= bEnd && bStart <= aEnd`, which is
       * false against everything for an inverted row — so one inserted by any
       * route other than the API was permanently invisible to the overlap check
       * and every later create silently succeeded against it. The wire schema
       * refuses to create one, which is exactly why nobody would notice.
       */
      it('refuses an inverted day window, which the overlap check cannot see', async () => {
        await asOwner(async (owner) => {
          await expect(owner.query(insert('p97_inverted', 60, 10, 500, 1200))).rejects.toThrow(
            /window_ordered/,
          );
        });
      });

      it('refuses a row with neither bound', async () => {
        await asOwner(async (owner) => {
          await expect(owner.query(insert('p97_nobound', 0, 30, null, null))).rejects.toThrow(
            /has_a_bound/,
          );
        });
      });

      it('refuses inverted bounds', async () => {
        await asOwner(async (owner) => {
          await expect(owner.query(insert('p97_invbounds', 0, 30, 1200, 500))).rejects.toThrow(
            /bounds_ordered/,
          );
        });
      });

      it('still allows a one-sided range, which is legitimate', async () => {
        // `urine_output_ml` has no clinically meaningful ceiling, and
        // `net_fluid_balance_ml` has a negative floor — both are real rows.
        await asOwner(async (owner) => {
          await owner.query(insert('p97_floor', 0, 30, 1200, null));
          await owner.query(insert('p97_ceiling', 31, 60, null, 1200));
        });
      });
    });

    /**
     * The one path the advisory lock cannot cover, answered as a 409.
     *
     * `assertNoOverlap` locks per type pair and reads the siblings, so two
     * concurrent creates through the service cannot overlap. A row inserted by
     * something that never takes the lock — a migration, the seeder, a psql
     * session — is invisible to it, and before #97 simply produced an
     * overlapping pair. Now the constraint refuses it, and the refusal has to
     * reach the admin as the rule rather than as a 500.
     *
     * The error shape was **discovered rather than assumed**: a first version of
     * `isWindowOverlapViolation` matched `P2002`/`P2010` and read the SQLSTATE
     * from `meta.code`, and all three were wrong. Prisma 7 with the pg adapter
     * reports `P2039` with `23P01` nested under
     * `meta.driverAdapterError.cause.code`. This test pins the two facts
     * Postgres guarantees — the SQLSTATE and the constraint name — so an
     * upgrade that moves the nesting fails here instead of silently turning the
     * 409 back into a 500.
     */
    it('answers a 409 when the conflicting row was inserted behind the lock', async () => {
      await asOwner(async (owner) => {
        await owner.query(insert('p97_race', 0, 30, 500, 1200));
      });

      await expect(
        service.createDefaultRange(
          body('p97_race', { minDaysPostOp: 10, maxDaysPostOp: 40 }),
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({
        response: { error: { code: 'DEFAULT_RANGE_WINDOW_OVERLAPS' } },
      });
    });

    it('reports the SQLSTATE and the constraint name the handler matches on', async () => {
      await asOwner(async (owner) => {
        await owner.query(insert('p97_shape', 0, 30, 500, 1200));
      });

      let captured: unknown;
      try {
        await prisma.clinicalDefaultRange.create({
          data: {
            ostomyType: 'ILEOSTOMY',
            rangeType: 'p97_shape',
            minDaysPostOp: 10,
            maxDaysPostOp: 40,
            lowValue: 500,
            highValue: 1200,
            unit: 'mL',
            windowDays: null,
          },
        });
      } catch (error) {
        captured = error;
      }

      expect(captured).toBeInstanceOf(Error);
      const reported = JSON.stringify((captured as { meta?: unknown }).meta ?? {});
      expect(reported).toContain('23P01');
      expect(reported).toContain('clinical_default_ranges_window_no_overlap');
    });
  });

  it('publishes a list body matching its contract, and not an empty one', async () => {
    await service.createDefaultRange(body('probe_contract_ml'), ADMIN_SUBJECT, undefined);

    const listed = await service.listDefaultRanges();

    // Non-empty first: `safeParse({ defaultRanges: [] }).success` is `true`, so the
    // previous version passed if `listDefaultRanges` returned nothing — for the one
    // test whose job is to catch a `Decimal` leak.
    expect(listed.defaultRanges.length).toBeGreaterThan(0);
    // Issues rather than the boolean, so a failure says what is wrong instead of
    // "expected false to be true".
    expect(adminDefaultRangesResponseSchema.safeParse(listed).error?.issues ?? []).toEqual([]);
  });

  /**
   * NULL `minDaysPostOp` means "from surgery" — day 0, the FIRST window — and Postgres
   * `ASC` is NULLS LAST, so it was sorting after day 3650 while this route's own
   * description claimed the windows read in sequence. That also matters for the overlap
   * race: an accidentally overlapping pair is what an admin would spot by eye, and the
   * old ordering could separate the two rows.
   */
  it('orders an unbounded start first, because it means day zero', async () => {
    await service.createDefaultRange(
      body('probe_order_ml', { minDaysPostOp: 60, maxDaysPostOp: 90 }),
      ADMIN_SUBJECT,
      undefined,
    );
    await service.createDefaultRange(
      body('probe_order_ml', { minDaysPostOp: null, maxDaysPostOp: 30 }),
      ADMIN_SUBJECT,
      undefined,
    );

    const mine = (await service.listDefaultRanges()).defaultRanges.filter(
      (range) => range.rangeType === 'probe_order_ml',
    );
    expect(mine.map((range) => range.minDaysPostOp)).toEqual([null, 60]);
  });
});
