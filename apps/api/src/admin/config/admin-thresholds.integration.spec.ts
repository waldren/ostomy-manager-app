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
 * P3.S3 PR B, ADR-0008. Against real PostgreSQL, as the runtime role.
 *
 * ## Why every test owns its own threshold row
 *
 * The first version mutated the seeded `stoma_output_single_entry_warning_ml` row and
 * called a `restoreSeededValue()` helper at the END of each test body. Three things
 * were wrong with that, and a reviewer found all three:
 *
 * 1. A failing assertion skipped its own restore, so the row stayed dirty and the next
 *    three tests failed for an unrelated reason. One of them was "leaves the value
 *    unchanged when the audit write fails" — which would then have reported a
 *    rollback failure while the rollback worked perfectly. A test pointing at the
 *    wrong defect is worse than no test.
 * 2. The fixture WAS the subject: the restore went through `updateThreshold`, so a
 *    real defect in it compounded across the suite instead of failing once.
 * 3. Every restore wrote an audit row, which is why the assertions had to read
 *    `rows[rows.length - 1]` — and that is exactly the blindness PR A's duplicate-row
 *    defect lived in. Nothing could assert that one update writes **one** audit row.
 *
 * So each test inserts its own key via the OWNER connection and asserts
 * `toHaveLength(1)`. `WARNING_KEY` is used only where the test genuinely needs the key
 * `ThresholdsService` reads.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../audit/audit.service';
import { PrismaClient } from '../../generated/prisma/client';
import { THRESHOLD_KEY, ThresholdsService } from '../../thresholds/thresholds.service';

import { adminThresholdsResponseSchema } from './admin-threshold-wire';
import { AdminThresholdsService, THRESHOLD_ENTITY_TYPE } from './admin-thresholds.service';

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
      '[admin-thresholds.integration.spec.ts] Docker is not reachable, but CI is set — refusing ' +
        'to silently skip.',
    );
  }
  // eslint-disable-next-line no-console
  console.warn('[admin-thresholds.integration.spec.ts] Docker is not reachable — skipping.');
}

const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'admin-thresholds-integration-test-only-password';
const ADMIN_SUBJECT = 'admin-integration-subject';
/** Seeded by the P3 migration. Used only where a test needs the key the server reads. */
const WARNING_KEY = THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML;
/** Also seeded, and `patient_adjustable = FALSE` — which is where that flag matters today. */
const SKEW_KEY = THRESHOLD_KEY.SYNC_CLOCK_SKEW_ALLOWANCE_SECONDS;

describe.skipIf(!dockerAvailable)('AdminThresholdsService — real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let service: AdminThresholdsService;
  let thresholds: ThresholdsService;
  let ownerDatabaseUrl: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('ostomy_admin_thresholds_test')
      .withUsername('ostomy_owner')
      .withPassword('owner-test-only-password')
      .start();
    ownerDatabaseUrl = container.getConnectionUri();

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

    const runtimeDatabaseUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@${container.getHost()}:${String(container.getPort())}/ostomy_admin_thresholds_test`;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeDatabaseUrl }) });
    // 60s TTL, so anything these tests see as fresh is the result of an explicit
    // invalidation rather than the TTL quietly expiring under them.
    thresholds = new ThresholdsService(prisma as never, 60_000);
    service = new AdminThresholdsService(
      prisma as never,
      new AuditService(prisma as never) as never,
      thresholds as never,
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  /**
   * Inserts a row this test owns, as the OWNER — so the fixture never travels through
   * the code under test and leaves no audit row of its own.
   */
  async function seedThreshold(
    key: string,
    options: {
      value?: number;
      tier?: string;
      unit?: string;
      description?: string | null;
      /**
       * #93's bounds. Required of this fixture because they are required of the
       * table: the columns are `NOT NULL` with the database default dropped, so
       * dropping them from this INSERT is a constraint violation rather than a
       * silently unbounded row. That is the forcing function working — an
       * inserter must say what the key may be set to.
       *
       * The defaults here are the full column width, which is what "no narrower
       * bound decided" means, so a test that does not care about #93 behaves as
       * it did before it.
       */
      minSettableValue?: number;
      maxSettableValue?: number;
    } = {},
  ): Promise<void> {
    const owner = new PgClient({ connectionString: ownerDatabaseUrl });
    await owner.connect();
    try {
      await owner.query(
        `INSERT INTO validation_thresholds
           (id, threshold_key, tier, value, unit, patient_adjustable, description,
            min_settable_value, max_settable_value, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, TRUE, $5, $6, $7, now(), now())
         ON CONFLICT (threshold_key) DO NOTHING`,
        [
          key,
          options.tier ?? 'TIER_2_SOFT_WARNING',
          options.value ?? 2000,
          options.unit ?? 'mL',
          options.description === undefined ? 'seeded by the test' : options.description,
          options.minSettableValue ?? 0.0001,
          options.maxSettableValue ?? 99999999.9999,
        ],
      );
    } finally {
      await owner.end();
    }
  }

  async function auditRowsFor(thresholdId: string) {
    return prisma.auditEvent.findMany({
      where: { entityType: THRESHOLD_ENTITY_TYPE, entityId: thresholdId },
      orderBy: { occurredAt: 'asc' },
    });
  }

  async function rowFor(key: string) {
    return prisma.validationThreshold.findUnique({ where: { thresholdKey: key } });
  }

  describe('reading', () => {
    it('publishes a body matching the contract the OpenAPI document declares', async () => {
      // Covers the Decimal to number projection, the ISO `updatedAt`, and the tier enum
      // in one assertion — and fails loudly if a Prisma `Decimal` ever leaks through.
      const listed = await service.listThresholds();

      expect(adminThresholdsResponseSchema.safeParse(listed).success).toBe(true);
    });

    it('lists the thresholds the migration seeded', async () => {
      const keys = (await service.listThresholds()).thresholds.map((row) => row.thresholdKey);

      expect(keys).toContain(WARNING_KEY);
      expect(keys).toContain(SKEW_KEY);
    });
  });

  describe('changing a value', () => {
    it('persists it and reports what now governs', async () => {
      await seedThreshold('p3s3_probe_value');

      const write = await service.updateThreshold(
        'p3s3_probe_value',
        { value: 1500, description: null },
        ADMIN_SUBJECT,
        undefined,
      );

      expect(write.threshold.value).toBe(1500);
      expect((await rowFor('p3s3_probe_value'))!.value.toNumber()).toBe(1500);
    });

    it('writes exactly one audit row, carrying both sides and the admin identity', async () => {
      await seedThreshold('p3s3_probe_audit', { value: 2000 });

      const write = await service.updateThreshold(
        'p3s3_probe_audit',
        { value: 1200, description: null },
        ADMIN_SUBJECT,
        undefined,
      );

      const rows = await auditRowsFor(write.thresholdId);
      // Exactly one. The previous fixture produced two per test, so a write that
      // recorded twice — the defect PR A actually shipped — would have passed.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.actorType).toBe('ADMIN');
      expect(rows[0]!.actorId).toBe(ADMIN_SUBJECT);
      expect(rows[0]!.action).toBe('UPDATE');
      expect(rows[0]!.reasonCode).toBe('admin_config_change');
      expect(rows[0]!.beforeValue).toMatchObject({ value: 2000 });
      expect(rows[0]!.afterValue).toMatchObject({ value: 1200 });
    });

    /**
     * The snapshot's completeness is the stated reason it carries the immutable fields,
     * so it is asserted as an exact key set rather than with `toMatchObject` — which
     * would pass while silently dropping one, the field-drop failure CLAUDE.md records
     * having cost two sprints on the observation write paths.
     */
    it('records every field of the snapshot, not just the number', async () => {
      await seedThreshold('p3s3_probe_snapshot');

      const write = await service.updateThreshold(
        'p3s3_probe_snapshot',
        { value: 1300, description: null },
        ADMIN_SUBJECT,
        undefined,
      );

      const rows = await auditRowsFor(write.thresholdId);
      expect(Object.keys(rows[0]!.afterValue as object).sort()).toEqual([
        'description',
        // #93's bounds are recorded on both sides even though they cannot change
        // through this surface. "Was this value legal when it was written?" is
        // not answerable from the value alone once a later migration narrows a
        // range, and the audit row is the only surviving record.
        'maxSettableValue',
        'minSettableValue',
        'patientAdjustable',
        'thresholdKey',
        'tier',
        'unit',
        'value',
      ]);
      expect(rows[0]!.afterValue).toMatchObject({ unit: 'mL', tier: 'TIER_2_SOFT_WARNING' });
    });

    it('records the correlation id when the request carries one', async () => {
      await seedThreshold('p3s3_probe_correlated');

      const write = await service.updateThreshold(
        'p3s3_probe_correlated',
        { value: 1900, description: null },
        ADMIN_SUBJECT,
        'request-xyz',
      );

      expect((await auditRowsFor(write.thresholdId))[0]!.correlationId).toBe('request-xyz');
    });
  });

  describe('fields this surface must not change', () => {
    it('leaves the tier, unit, key and patient-adjustable flag exactly as they were', async () => {
      await seedThreshold('p3s3_probe_immutable');
      const before = await rowFor('p3s3_probe_immutable');

      await service.updateThreshold(
        'p3s3_probe_immutable',
        { value: 1400, description: null },
        ADMIN_SUBJECT,
        undefined,
      );

      const after = await rowFor('p3s3_probe_immutable');
      expect(after!.tier).toBe(before!.tier);
      expect(after!.unit).toBe(before!.unit);
      expect(after!.patientAdjustable).toBe(before!.patientAdjustable);
      expect(after!.thresholdKey).toBe(before!.thresholdKey);
    });

    /**
     * Against the row where the flag actually matters today.
     *
     * The first version only exercised the stoma-output row, where
     * `patient_adjustable` is `TRUE` — so a write that flipped it would have passed.
     * `sync_clock_skew_allowance_seconds` is seeded `FALSE`, because a patient who
     * could widen it could make their own device win every conflict (ADR-0019).
     */
    it('cannot flip patient-adjustable on the row that is seeded false', async () => {
      const before = await rowFor(SKEW_KEY);
      expect(before!.patientAdjustable).toBe(false);

      await service.updateThreshold(
        SKEW_KEY,
        { value: 300, description: null },
        ADMIN_SUBJECT,
        undefined,
      );

      expect((await rowFor(SKEW_KEY))!.patientAdjustable).toBe(false);
    });
  });

  describe('the admin label', () => {
    it('clears it with null, which is the only empty representation', async () => {
      await seedThreshold('p3s3_probe_label', { description: 'before' });

      await service.updateThreshold(
        'p3s3_probe_label',
        { value: 100, description: null },
        ADMIN_SUBJECT,
        undefined,
      );

      // `NULL`, not `''`. An empty string would be a second "no label" state the read
      // surface renders identically and the API could never return to null.
      expect((await rowFor('p3s3_probe_label'))!.description).toBeNull();
    });

    it('replaces it with a new label', async () => {
      await seedThreshold('p3s3_probe_relabel', { description: 'before' });

      await service.updateThreshold(
        'p3s3_probe_relabel',
        { value: 100, description: 'after' },
        ADMIN_SUBJECT,
        undefined,
      );

      expect((await rowFor('p3s3_probe_relabel'))!.description).toBe('after');
    });
  });

  describe('concurrency', () => {
    /**
     * The defect this closes is not a lost value — it is a hole in the audit chain.
     *
     * `findUnique` then `update({ where: { id } })` at READ COMMITTED let both
     * transactions read 2000; the second's predicate still matched on the primary key,
     * so it overwrote the first and the log held `2000 -> A` and `2000 -> B`. Nothing
     * then recorded that A ever governed, and the before value is the only record of
     * what the rule used to be — nothing on a stored observation says which bound it
     * was checked against.
     */
    it('refuses a write whose row moved underneath it, rather than overwriting silently', async () => {
      await seedThreshold('p3s3_probe_concurrent', { value: 2000 });
      const stale = (await rowFor('p3s3_probe_concurrent'))!.updatedAt;

      await service.updateThreshold(
        'p3s3_probe_concurrent',
        { value: 1500, description: null },
        ADMIN_SUBJECT,
        undefined,
      );

      // A second caller holding the pre-change token must be told, not applied.
      await expect(
        service.updateThreshold(
          'p3s3_probe_concurrent',
          { value: 1200, description: null },
          ADMIN_SUBJECT,
          undefined,
          stale,
        ),
      ).rejects.toMatchObject({
        status: 409,
        response: { error: { code: 'THRESHOLD_MODIFIED_CONCURRENTLY' } },
      });

      // And the first change still governs.
      expect((await rowFor('p3s3_probe_concurrent'))!.value.toNumber()).toBe(1500);
    });

    it('accepts a write whose token is current', async () => {
      await seedThreshold('p3s3_probe_token', { value: 2000 });
      const current = (await rowFor('p3s3_probe_token'))!.updatedAt;

      const write = await service.updateThreshold(
        'p3s3_probe_token',
        { value: 1700, description: null },
        ADMIN_SUBJECT,
        undefined,
        current,
      );

      expect(write.threshold.value).toBe(1700);
      // The returned token is the one a caller needs for its next write.
      expect(write.updatedAt).toBe((await rowFor('p3s3_probe_token'))!.updatedAt.toISOString());
    });
  });

  describe('refusals', () => {
    it('refuses an unknown key as a 404, and creates nothing', async () => {
      await expect(
        service.updateThreshold(
          'a_key_nobody_defined',
          { value: 1, description: null },
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({
        status: 404,
        response: { error: { code: 'THRESHOLD_NOT_FOUND' } },
      });

      expect(await rowFor('a_key_nobody_defined')).toBeNull();
    });

    it('writes no audit row for a refused key', async () => {
      const before = await prisma.auditEvent.count({
        where: { entityType: THRESHOLD_ENTITY_TYPE },
      });

      await expect(
        service.updateThreshold(
          'another_key_nobody_defined',
          { value: 1, description: null },
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toThrow();

      expect(await prisma.auditEvent.count({ where: { entityType: THRESHOLD_ENTITY_TYPE } })).toBe(
        before,
      );
    });
  });

  describe('the range a key may be set within (#93)', () => {
    const BOUNDED = 'p3s3_probe_bounded';

    beforeAll(async () => {
      await seedThreshold(BOUNDED, { value: 300, minSettableValue: 60, maxSettableValue: 3600 });
    });

    it('reports the bounds on the read, so a caller can show them before typing', async () => {
      const row = (await service.listThresholds()).thresholds.find(
        (candidate) => candidate.thresholdKey === BOUNDED,
      );

      expect(row).toMatchObject({ minSettableValue: 60, maxSettableValue: 3600 });
    });

    it('refuses a value below the floor, naming the field and the rule only', async () => {
      await expect(
        service.updateThreshold(BOUNDED, { value: 1, description: null }, ADMIN_SUBJECT, undefined),
      ).rejects.toMatchObject({
        response: {
          error: {
            code: 'INVALID_THRESHOLD_UPDATE',
            fields: [{ field: 'value', rule: 'outside_settable_range' }],
          },
        },
      });
    });

    it('refuses a value above the ceiling', async () => {
      await expect(
        service.updateThreshold(
          BOUNDED,
          { value: 86_400, description: null },
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toMatchObject({
        response: { error: { code: 'INVALID_THRESHOLD_UPDATE' } },
      });
    });

    it('changes nothing and writes no audit row when it refuses', async () => {
      const before = await rowFor(BOUNDED);
      const auditBefore = await auditRowsFor(before!.id);

      await expect(
        service.updateThreshold(BOUNDED, { value: 2, description: null }, ADMIN_SUBJECT, undefined),
      ).rejects.toThrow();

      const after = await rowFor(BOUNDED);
      expect(after!.value.toNumber()).toBe(before!.value.toNumber());
      expect(after!.updatedAt.toISOString()).toBe(before!.updatedAt.toISOString());
      expect(await auditRowsFor(before!.id)).toHaveLength(auditBefore.length);
    });

    it('accepts both boundaries, because the range is inclusive', async () => {
      // Asserted because an exclusive comparison is the likelier typo, and it
      // would make the published bounds a lie at exactly the two values a
      // careful admin is most likely to enter.
      for (const value of [60, 3600]) {
        const write = await service.updateThreshold(
          BOUNDED,
          { value, description: null },
          ADMIN_SUBJECT,
          undefined,
        );
        expect(write.threshold.value).toBe(value);
      }
    });

    /**
     * The database enforces this too, which is the difference between this table
     * and `clinical_default_ranges` (#97). Written as the OWNER so it bypasses
     * the service entirely: the point is that a migration, a seeder or a psql
     * session cannot create a state the API refuses.
     */
    it('is enforced by a CHECK constraint, not only by the service', async () => {
      const owner = new PgClient({ connectionString: ownerDatabaseUrl });
      await owner.connect();
      try {
        await expect(
          owner.query(`UPDATE validation_thresholds SET value = 1 WHERE threshold_key = $1`, [
            BOUNDED,
          ]),
        ).rejects.toThrow(/validation_thresholds_value_within_settable_range/);

        await expect(
          owner.query(
            `UPDATE validation_thresholds
                SET min_settable_value = 5000, max_settable_value = 100
              WHERE threshold_key = $1`,
            [BOUNDED],
          ),
        ).rejects.toThrow(/validation_thresholds_settable_range_ordered/);
      } finally {
        await owner.end();
      }
    });

    it('refuses to insert a threshold row that states no bounds', async () => {
      // The forcing function: `NOT NULL` with no database default, so a future
      // migration cannot add a key and leave it silently unbounded.
      const owner = new PgClient({ connectionString: ownerDatabaseUrl });
      await owner.connect();
      try {
        await expect(
          owner.query(
            `INSERT INTO validation_thresholds
               (id, threshold_key, tier, value, unit, patient_adjustable, created_at, updated_at)
             VALUES (gen_random_uuid(), 'p3s3_probe_unbounded', 'TIER_2_SOFT_WARNING', 1, 'mL',
                     TRUE, now(), now())`,
          ),
        ).rejects.toThrow(/min_settable_value/);
      } finally {
        await owner.end();
      }
    });

    describe('what the migration decided, and what it deliberately did not', () => {
      it('bounds the clock-skew allowance, which ADR-0019 already reasoned about', async () => {
        const row = (await service.listThresholds()).thresholds.find(
          (candidate) => candidate.thresholdKey === SKEW_KEY,
        );

        expect(row).toMatchObject({ minSettableValue: 60, maxSettableValue: 3600 });
      });

      /**
       * The decision #93 was open for, now made — and this test replaced the one
       * that pinned the undecided state, in the same change, which is what that
       * tripwire existed to force.
       *
       * 1,000 to 3,000 mL. The floor is set by the night drainage bag: high-output
       * ostomates empty a 1,500-2,000 mL overnight bag as one entry of roughly
       * 800-1,500 mL, and a warning below that fires every morning for exactly the
       * patients whose output matters most — SRS §3.8's own failure mode. The
       * ceiling is where a single emptying stops being physically plausible and the
       * right tool becomes Tier 1's block, and it deliberately leaves headroom under
       * the planned `stoma_output_absolute_ceiling_ml`, because a Tier 2 warning
       * above a Tier 1 block can never fire and nothing enforces that coherence.
       *
       * The reasoning is in the migration. These numbers were chosen by an
       * implementer and want a clinician's ratification; replacing them is one
       * `UPDATE` plus this assertion.
       */
      it('bounds the stoma-output warning to 1,000-3,000 mL', async () => {
        const row = (await service.listThresholds()).thresholds.find(
          (candidate) => candidate.thresholdKey === WARNING_KEY,
        );

        expect(row).toMatchObject({ minSettableValue: 1000, maxSettableValue: 3000 });
      });

      it('leaves SRS AC 2.1 AC2 default of 2,000 mL inside the range it chose', async () => {
        // Not decoration: a range excluding its own seeded value would have been
        // refused by the `value_within_settable_range` CHECK, so this asserts the
        // pair was chosen around the default rather than in spite of it.
        const row = (await service.listThresholds()).thresholds.find(
          (candidate) => candidate.thresholdKey === WARNING_KEY,
        );

        expect(row!.value).toBeGreaterThanOrEqual(row!.minSettableValue);
        expect(row!.value).toBeLessThanOrEqual(row!.maxSettableValue);
      });
    });
  });

  describe('the audit row and the change commit together', () => {
    it('passes the transaction client to the audit write', async () => {
      await seedThreshold('p3s3_probe_tx');
      const received: unknown[] = [];
      const real = new AuditService(prisma as never);
      const spy = {
        record: async (context: unknown, tx?: unknown) => {
          received.push(tx);
          return real.record(context as never, tx as never);
        },
      };
      const spied = new AdminThresholdsService(
        prisma as never,
        spy as never,
        new ThresholdsService(prisma as never, 60_000) as never,
      );

      await spied.updateThreshold(
        'p3s3_probe_tx',
        { value: 1600, description: null },
        ADMIN_SUBJECT,
        undefined,
      );

      expect(received).toHaveLength(1);
      // Identity is the discriminator: the service is constructed with exactly this
      // client, so `this.prisma` would be referentially equal while a transaction
      // client never is. `toBeDefined()` alone passed twice with the guarantee removed.
      expect(received[0]).not.toBe(prisma);
    });

    it('leaves the value unchanged when the audit write fails', async () => {
      await seedThreshold('p3s3_probe_rollback', { value: 2000 });
      const audit = {
        record: () => {
          throw new Error('audit unavailable');
        },
      };
      const brittle = new AdminThresholdsService(
        prisma as never,
        audit as never,
        new ThresholdsService(prisma as never, 60_000) as never,
      );

      await expect(
        brittle.updateThreshold(
          'p3s3_probe_rollback',
          { value: 999, description: null },
          ADMIN_SUBJECT,
          undefined,
        ),
      ).rejects.toThrow();

      // Against the value this test seeded, not a shared row an earlier test may have
      // left dirty — which is what made the old version of this assertion able to
      // report a rollback failure while the rollback worked.
      expect((await rowFor('p3s3_probe_rollback'))!.value.toNumber()).toBe(2000);
    });

    /** ADR-0011, on an ADMIN-actor row for a threshold specifically. */
    it('cannot amend the audit row it just wrote', async () => {
      await seedThreshold('p3s3_probe_immutable_audit');
      const write = await service.updateThreshold(
        'p3s3_probe_immutable_audit',
        { value: 1950, description: null },
        ADMIN_SUBJECT,
        undefined,
      );

      await expect(
        prisma.auditEvent.update({
          where: { id: write.auditEventId },
          data: { afterValue: { value: 0 } },
        }),
      ).rejects.toThrow(/permission denied/i);
    });
  });

  /**
   * AC 13.2 AC2: an admin change governs "from the next successful fetch, with no
   * application release". `getVolumetricThresholds()` is what `GET /api/v1/thresholds`
   * serves, so without the invalidation the change would sit invisible behind the TTL
   * on the very path the acceptance criterion names.
   *
   * The one test that must use the real seeded key, because that is the key the server
   * reads.
   */
  it('is felt by the patient-facing read path without waiting out the cache TTL', async () => {
    const seeded = await thresholds.getVolumetricThresholds();
    expect(seeded.softWarningMaxMl).toBe(2000);

    await service.updateThreshold(
      WARNING_KEY,
      { value: 1750, description: null },
      ADMIN_SUBJECT,
      undefined,
    );

    expect((await thresholds.getVolumetricThresholds()).softWarningMaxMl).toBe(1750);
  });
});
