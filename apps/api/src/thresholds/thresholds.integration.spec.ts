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
 * `thresholds.service.spec.ts` proves the caching/invalidation logic against
 * a fake Prisma client; this file proves the same service against real rows
 * in real PostgreSQL (ADR-0002), connected as the runtime role (ADR-0011) —
 * the same role `ThresholdsService` runs as in every real environment, so a
 * grant gap (a future migration that forgets to grant the runtime role
 * `SELECT` on `validation_thresholds`) would fail here, not only in
 * production.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { PrismaPg } from '@prisma/adapter-pg';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaClient } from '../generated/prisma/client';
import { ThresholdsService, THRESHOLD_KEY } from './thresholds.service';

const API_ROOT = path.resolve(__dirname, '..', '..');

function isDockerAvailable(): boolean {
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], {
      stdio: 'ignore',
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = isDockerAvailable();
if (!dockerAvailable) {
  if (process.env.CI) {
    throw new Error(
      '[thresholds.integration.spec.ts] Docker is not reachable, but CI is set — refusing to ' +
        'silently skip.',
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    '[thresholds.integration.spec.ts] Docker is not reachable — skipping. Run with a Docker ' +
      'daemon available (e.g. `pnpm --filter @ostomy/api test:integration`) to exercise this suite.',
  );
}

const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'thresholds-integration-test-only-password';

describe.skipIf(!dockerAvailable)(
  'ThresholdsService — real PostgreSQL, connected as the runtime role (ADR-0011)',
  () => {
    let container: StartedPostgreSqlContainer;
    let runtimePrismaClient: PrismaClient;
    let runtimeDatabaseUrl: string;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17-alpine')
        .withDatabase('ostomy_thresholds_test')
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
        // Seeded here, not by a migration (P1.S3 left this table empty on
        // purpose; P2.S4 owns the seed generator) — the owner role inserts
        // it, matching how a real deploy's seed/maintenance script would.
        await owner.query(
          `INSERT INTO validation_thresholds (id, threshold_key, tier, value, unit, updated_at)
           VALUES
             (gen_random_uuid(), $1, 'TIER_2_SOFT_WARNING', 2000, 'mL', now()),
             (gen_random_uuid(), $2, 'OPERATIONAL', 300, 'seconds', now())`,
          [
            THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML,
            THRESHOLD_KEY.SYNC_CLOCK_SKEW_ALLOWANCE_SECONDS,
          ],
        );
      } finally {
        await owner.end();
      }

      const host = container.getHost();
      const port = container.getPort();
      const database = container.getDatabase();
      runtimeDatabaseUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@${host}:${port}/${database}`;

      runtimePrismaClient = new PrismaClient({
        adapter: new PrismaPg({ connectionString: runtimeDatabaseUrl }),
      });
      await runtimePrismaClient.patient.findMany({ take: 0 });
    }, 90_000);

    afterAll(async () => {
      await runtimePrismaClient?.$disconnect();
      await container?.stop();
    });

    it('reads real validation_thresholds rows into the exact VolumetricValidationThresholds shape packages/core defines', async () => {
      const service = new ThresholdsService(runtimePrismaClient as never, 60 * 60 * 1000);

      const thresholds = await service.getVolumetricThresholds();

      expect(thresholds).toEqual({ softWarningMaxMl: 2000, maxClockSkewMs: 300_000 });
    });

    it('invalidate() picks up a changed row without a restart — a long TTL alone would not', async () => {
      const service = new ThresholdsService(runtimePrismaClient as never, 60 * 60 * 1000);

      const before = await service.getVolumetricThresholds();
      expect(before.softWarningMaxMl).toBe(2000);

      // Simulates an admin config write (P3.S3, not built yet) landing
      // while this service instance is still running — the scenario AC4
      // ("cache invalidation demonstrably picks up a changed row without a
      // restart") names explicitly. Using the owner connection only because
      // this test has no admin-write API yet to go through; the property
      // under test is ThresholdsService's cache behaviour, not who wrote
      // the row.
      const owner = new PgClient({ connectionString: container.getConnectionUri() });
      await owner.connect();
      try {
        await owner.query(
          `UPDATE validation_thresholds SET value = 1800 WHERE threshold_key = $1`,
          [THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML],
        );
      } finally {
        await owner.end();
      }

      // Without invalidate(), the long TTL above would still return 2000 —
      // this assertion is what proves invalidation, not merely a fresh read.
      const stillCached = await service.getVolumetricThresholds();
      expect(stillCached.softWarningMaxMl).toBe(2000);

      service.invalidate();
      const afterInvalidate = await service.getVolumetricThresholds();
      expect(afterInvalidate.softWarningMaxMl).toBe(1800);

      // Restore the seeded value so this test is order-independent with
      // respect to the one above.
      const restore = new PgClient({ connectionString: container.getConnectionUri() });
      await restore.connect();
      try {
        await restore.query(
          `UPDATE validation_thresholds SET value = 2000 WHERE threshold_key = $1`,
          [THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML],
        );
      } finally {
        await restore.end();
      }
    });

    it('reads active value-set members, ordered, connected for real', async () => {
      const owner = new PgClient({ connectionString: container.getConnectionUri() });
      await owner.connect();
      let valueSetId: string;
      try {
        const inserted = await owner.query(
          `INSERT INTO value_sets (id, key, updated_at) VALUES (gen_random_uuid(), 'integration-test-fluid-type', now()) RETURNING id`,
        );
        valueSetId = inserted.rows[0].id as string;
        await owner.query(
          `INSERT INTO value_set_members (id, value_set_id, code, status, sort_order, updated_at) VALUES
             (gen_random_uuid(), $1, 'water', 'ACTIVE', 0, now()),
             (gen_random_uuid(), $1, 'juice', 'ACTIVE', 1, now()),
             (gen_random_uuid(), $1, 'retired_option', 'RETIRED', 2, now())`,
          [valueSetId],
        );
      } finally {
        await owner.end();
      }

      const service = new ThresholdsService(runtimePrismaClient as never, 60 * 60 * 1000);
      const members = await service.getActiveValueSetMembers('integration-test-fluid-type');

      // The retired member is never returned — CLAUDE.md "Value-set members
      // are retired, never deleted": retirement means "stop offering this",
      // which this assertion is the one that actually proves.
      expect(members).toEqual([
        { code: 'water', sortOrder: 0 },
        { code: 'juice', sortOrder: 1 },
      ]);
    });
  },
);
