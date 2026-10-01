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
 * The guarantees here are database guarantees: that the change and its audit row share
 * one transaction, that the immutable columns are still immutable after an update, and
 * that a change is felt by the patient-facing read path rather than sitting behind the
 * cache TTL — which is what AC 13.2 AC2 actually asks for.
 *
 * The wire contract is unit-tested separately, because this suite skips itself when
 * Docker is unreachable and the refusals are too important to live only here.
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
/** Seeded by the P3 migration, which is also why there is nothing to insert here. */
const WARNING_KEY = THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML;

describe.skipIf(!dockerAvailable)('AdminThresholdsService — real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let service: AdminThresholdsService;
  let thresholds: ThresholdsService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('ostomy_admin_thresholds_test')
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

  async function auditRowsFor(thresholdId: string) {
    return prisma.auditEvent.findMany({
      where: { entityType: THRESHOLD_ENTITY_TYPE, entityId: thresholdId },
      orderBy: { occurredAt: 'asc' },
    });
  }

  /** Puts the row back, so each test starts from the seeded bound. */
  async function restoreSeededValue(): Promise<void> {
    await service.updateThreshold(WARNING_KEY, { value: 2000 }, ADMIN_SUBJECT, undefined);
  }

  it('lists the thresholds the migration seeded', async () => {
    const listed = await service.listThresholds();
    const keys = listed.thresholds.map((threshold) => threshold.thresholdKey);

    expect(keys).toContain(WARNING_KEY);
    expect(keys).toContain(THRESHOLD_KEY.SYNC_CLOCK_SKEW_ALLOWANCE_SECONDS);
  });

  it('changes the value and reports what now governs', async () => {
    const write = await service.updateThreshold(
      WARNING_KEY,
      { value: 1500 },
      ADMIN_SUBJECT,
      undefined,
    );

    expect(write.threshold.value).toBe(1500);
    const row = await prisma.validationThreshold.findUnique({
      where: { thresholdKey: WARNING_KEY },
    });
    expect(row!.value.toNumber()).toBe(1500);
    await restoreSeededValue();
  });

  /**
   * A threshold change is the one admin action whose effect is invisible in the data it
   * governs: nothing about a later observation records which bound it was checked
   * against. The before value is therefore the only record of what the rule used to be.
   */
  it('records both sides, with the admin identity', async () => {
    const write = await service.updateThreshold(
      WARNING_KEY,
      { value: 1200 },
      ADMIN_SUBJECT,
      undefined,
    );

    const rows = await auditRowsFor(write.thresholdId);
    const latest = rows[rows.length - 1]!;
    expect(latest.actorType).toBe('ADMIN');
    expect(latest.actorId).toBe(ADMIN_SUBJECT);
    expect(latest.action).toBe('UPDATE');
    expect(latest.beforeValue).toMatchObject({ value: 2000 });
    expect(latest.afterValue).toMatchObject({ value: 1200 });
    await restoreSeededValue();
  });

  /**
   * The snapshot carries the immutable fields too, so a reader a year later can tell
   * what the number MEANT without joining back to a table that may have migrated. A
   * bare `2000 -> 1200` does not say mL, does not say soft warning, and does not say
   * which rule it fed.
   */
  it('records the unit and tier alongside the value, not just the number', async () => {
    const write = await service.updateThreshold(
      WARNING_KEY,
      { value: 1300 },
      ADMIN_SUBJECT,
      undefined,
    );

    const rows = await auditRowsFor(write.thresholdId);
    expect(rows[rows.length - 1]!.afterValue).toMatchObject({
      unit: 'mL',
      tier: 'TIER_2_SOFT_WARNING',
      thresholdKey: WARNING_KEY,
    });
    await restoreSeededValue();
  });

  /**
   * The wire contract refuses these at the edge; this proves the write path does not
   * touch them even so. The two checks are independent: a schema can be relaxed by one
   * careless edit, and then this is what still holds.
   */
  it('leaves the tier, unit and patient-adjustable flag exactly as they were', async () => {
    const before = await prisma.validationThreshold.findUnique({
      where: { thresholdKey: WARNING_KEY },
    });

    await service.updateThreshold(WARNING_KEY, { value: 1400 }, ADMIN_SUBJECT, undefined);

    const after = await prisma.validationThreshold.findUnique({
      where: { thresholdKey: WARNING_KEY },
    });
    expect(after!.tier).toBe(before!.tier);
    expect(after!.unit).toBe(before!.unit);
    expect(after!.patientAdjustable).toBe(before!.patientAdjustable);
    expect(after!.thresholdKey).toBe(before!.thresholdKey);
    await restoreSeededValue();
  });

  it('refuses an unknown key as a 404, and creates nothing', async () => {
    await expect(
      service.updateThreshold('a_key_nobody_defined', { value: 1 }, ADMIN_SUBJECT, undefined),
    ).rejects.toMatchObject({
      status: 404,
      response: { error: { code: 'THRESHOLD_NOT_FOUND' } },
    });

    // No upsert: a created row would be configuration nothing reads.
    expect(
      await prisma.validationThreshold.findUnique({
        where: { thresholdKey: 'a_key_nobody_defined' },
      }),
    ).toBeNull();
  });

  /**
   * AC 13.2 AC2: an admin change governs "from the next successful fetch, with no
   * application release". `getVolumetricThresholds()` is what `GET /api/v1/thresholds`
   * serves, so without the invalidation the change would sit invisible behind the TTL
   * on the very path the acceptance criterion names.
   */
  it('is felt by the patient-facing read path without waiting out the cache TTL', async () => {
    const seeded = await thresholds.getVolumetricThresholds();
    expect(seeded.softWarningMaxMl).toBe(2000);

    await service.updateThreshold(WARNING_KEY, { value: 1750 }, ADMIN_SUBJECT, undefined);

    const governing = await thresholds.getVolumetricThresholds();
    expect(governing.softWarningMaxMl).toBe(1750);
    await restoreSeededValue();
  });

  it('passes the transaction client to the audit write, so the two commit together', async () => {
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

    await spied.updateThreshold(WARNING_KEY, { value: 1600 }, ADMIN_SUBJECT, undefined);

    expect(received).toHaveLength(1);
    // Identity is the discriminator: the service is constructed with exactly this
    // client, so `this.prisma` would be referentially equal while a transaction client
    // never is. `toBeDefined()` alone passes for either, which is how PR A's version of
    // this test stayed green with the guarantee removed — twice.
    expect(received[0]).not.toBe(prisma);
    await restoreSeededValue();
  });

  it('leaves the value unchanged when the audit write fails', async () => {
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
      brittle.updateThreshold(WARNING_KEY, { value: 999 }, ADMIN_SUBJECT, undefined),
    ).rejects.toThrow();

    const row = await prisma.validationThreshold.findUnique({
      where: { thresholdKey: WARNING_KEY },
    });
    expect(row!.value.toNumber()).toBe(2000);
  });

  it('records the correlation id when the request carries one', async () => {
    const write = await service.updateThreshold(
      WARNING_KEY,
      { value: 1900 },
      ADMIN_SUBJECT,
      'request-xyz',
    );

    const rows = await auditRowsFor(write.thresholdId);
    expect(rows[rows.length - 1]!.correlationId).toBe('request-xyz');
    await restoreSeededValue();
  });

  describe('the admin label', () => {
    it('leaves the existing label alone when none is sent', async () => {
      const before = await prisma.validationThreshold.findUnique({
        where: { thresholdKey: WARNING_KEY },
      });
      expect(before!.description).not.toBeNull();

      await service.updateThreshold(WARNING_KEY, { value: 1850 }, ADMIN_SUBJECT, undefined);

      const after = await prisma.validationThreshold.findUnique({
        where: { thresholdKey: WARNING_KEY },
      });
      expect(after!.description).toBe(before!.description);
      await restoreSeededValue();
    });

    it('clears it when an empty string is sent, which is a different intent', async () => {
      const original = await prisma.validationThreshold.findUnique({
        where: { thresholdKey: WARNING_KEY },
      });

      await service.updateThreshold(
        WARNING_KEY,
        { value: 1800, description: '' },
        ADMIN_SUBJECT,
        undefined,
      );

      const after = await prisma.validationThreshold.findUnique({
        where: { thresholdKey: WARNING_KEY },
      });
      expect(after!.description).toBe('');
      // Put it back, so a later test's "label is unchanged" assertion is meaningful.
      await service.updateThreshold(
        WARNING_KEY,
        { value: 2000, description: original!.description ?? '' },
        ADMIN_SUBJECT,
        undefined,
      );
    });
  });

  /** ADR-0011, on an ADMIN-actor row for a threshold specifically. */
  it('cannot amend the audit row it just wrote', async () => {
    const write = await service.updateThreshold(
      WARNING_KEY,
      { value: 1950 },
      ADMIN_SUBJECT,
      undefined,
    );

    await expect(
      prisma.auditEvent.update({
        where: { id: write.auditEventId },
        data: { afterValue: { value: 0 } },
      }),
    ).rejects.toThrow(/permission denied/i);
    await restoreSeededValue();
  });
});
