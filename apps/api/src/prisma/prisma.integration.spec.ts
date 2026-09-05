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

// No spec acceptance criterion covers schema/infrastructure work (SRS_v2
// §7 has none for P1.S3 — see docs/testing.md "Where no spec AC exists").
// This describes P1.S3's own exit criteria plainly instead of inventing an
// AC id: the migration applies cleanly to an empty AND a populated
// database, and the runtime role can SELECT/INSERT but never UPDATE/DELETE
// `audit_events` (ADR-0011).
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

const API_ROOT = path.resolve(__dirname, '..', '..');

/**
 * A synchronous, best-effort Docker-availability check, run at module
 * collection time (before any `describe`/`beforeAll` executes) — vitest
 * collects test files synchronously, so this is the earliest point a
 * `describe.skipIf` can act on it. `docker version` is a fast, side-effect
 * free call that fails immediately (rather than hanging) when no daemon is
 * reachable, matching docs/testing.md: "Integration tests require a Docker
 * daemon. They are skipped with a clear message, not silently, when one is
 * unavailable."
 */
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
  // The explicit, visible skip message docs/testing.md requires; console
  // output here is test-runner diagnostics, not application logging, so
  // the "never log PHI" rule does not apply.
  // eslint-disable-next-line no-console
  console.warn(
    '[prisma.integration.spec.ts] Docker is not reachable — skipping. ' +
      'Run with a Docker daemon available (e.g. `pnpm --filter @ostomy/api test:integration`) to exercise this suite.',
  );
}

// The literal role name the migration creates (see that file's header
// comment on why this cannot be parameterized). A throwaway,
// this-process-only password — never infra/db/bootstrap-roles.sql's real
// one, and never committed anywhere outside this file.
const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'integration-test-only-password';

describe.skipIf(!dockerAvailable)(
  'P1.S3 schema core — migration and runtime-role grants against real PostgreSQL',
  () => {
    let container: StartedPostgreSqlContainer;
    let ownerDatabaseUrl: string;
    let runtimeClient: PrismaClient;
    let plainRuntimePgClient: PgClient;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17-alpine')
        .withDatabase('ostomy_test')
        .withUsername('ostomy_owner')
        .withPassword('owner-test-only-password')
        .start();
      // Testcontainers' bootstrap user is the Postgres image's own
      // superuser (same as `POSTGRES_USER` in infra/docker-compose.yml) —
      // this IS the "owner" role ADR-0011 describes, not a stand-in for it.
      ownerDatabaseUrl = container.getConnectionUri();
    }, 60_000);

    afterAll(async () => {
      await runtimeClient?.$disconnect();
      await plainRuntimePgClient?.end();
      await container?.stop();
    });

    it('applies the initial migration cleanly to an empty database', () => {
      expect(() => runMigrateDeploy(ownerDatabaseUrl)).not.toThrow();
    });

    it('re-applying the migration against an already-migrated, non-empty database is a clean no-op (the case that matters — docs/deployment-development.md)', async () => {
      // Populate it first — a real row, not just an already-applied
      // migration record — so this is genuinely the "existing rows" case
      // docs/deployment-development.md calls out, not merely Prisma's own
      // migration-history bookkeeping.
      const owner = new PgClient({ connectionString: ownerDatabaseUrl });
      await owner.connect();
      try {
        await owner.query(
          `INSERT INTO patients (id, created_at, updated_at) VALUES ('populated-check-patient', now(), now())`,
        );
      } finally {
        await owner.end();
      }

      expect(() => runMigrateDeploy(ownerDatabaseUrl)).not.toThrow();

      const verify = new PgClient({ connectionString: ownerDatabaseUrl });
      await verify.connect();
      try {
        const result = await verify.query(
          `SELECT id FROM patients WHERE id = 'populated-check-patient'`,
        );
        expect(result.rowCount).toBe(1);
      } finally {
        await verify.end();
      }
    });

    it("sets the runtime role's password the same way infra/db/bootstrap-roles.sql does — the migration only creates the role NOLOGIN", async () => {
      const owner = new PgClient({ connectionString: ownerDatabaseUrl });
      await owner.connect();
      try {
        const before = await owner.query(`SELECT rolcanlogin FROM pg_roles WHERE rolname = $1`, [
          RUNTIME_ROLE,
        ]);
        expect(before.rows[0]?.rolcanlogin).toBe(false);

        await owner.query(`ALTER ROLE "${RUNTIME_ROLE}" WITH LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
      } finally {
        await owner.end();
      }

      const runtimeDatabaseUrl = buildRuntimeDatabaseUrl(container);
      plainRuntimePgClient = new PgClient({ connectionString: runtimeDatabaseUrl });
      await plainRuntimePgClient.connect();

      runtimeClient = new PrismaClient({
        adapter: new PrismaPg({ connectionString: runtimeDatabaseUrl }),
      });
      // Lazy connection (see prisma.service.ts) — force it now so later
      // tests are asserting on the grant, not on connection setup latency.
      await runtimeClient.patient.findMany({ take: 0 });
    });

    it('lets the runtime role SELECT and INSERT on audit_events (ADR-0011)', async () => {
      const before = await runtimeClient.auditEvent.findMany();
      expect(before).toEqual([]);

      const created = await runtimeClient.auditEvent.create({
        data: {
          actorType: 'SYSTEM',
          actorId: 'integration-test',
          action: 'CREATE',
          entityType: 'observation',
          entityId: 'test-entity',
          reasonCode: 'direct_write',
          afterValue: { note: 'no PHI — synthetic integration-test fixture only' },
        },
      });
      expect(created.id).toBeDefined();
    });

    it('refuses UPDATE on audit_events for the runtime role — no code path and no grant permits it (ADR-0011)', async () => {
      await expect(
        plainRuntimePgClient.query(`UPDATE audit_events SET reason_code = 'tampered'`),
      ).rejects.toMatchObject({ message: expect.stringContaining('permission denied') });
    });

    it('refuses DELETE on audit_events for the runtime role — no code path and no grant permits it (ADR-0011)', async () => {
      await expect(plainRuntimePgClient.query(`DELETE FROM audit_events`)).rejects.toMatchObject({
        message: expect.stringContaining('permission denied'),
      });
    });

    it('contrast case: the runtime role DOES hold full CRUD on an ordinary table (patients) — the audit restriction above is deliberate, not a blanket lockout', async () => {
      await plainRuntimePgClient.query(
        `INSERT INTO patients (id, created_at, updated_at) VALUES ('contrast-check-patient', now(), now())`,
      );
      await plainRuntimePgClient.query(
        `UPDATE patients SET updated_at = now() WHERE id = 'contrast-check-patient'`,
      );
      const deleteResult = await plainRuntimePgClient.query(
        `DELETE FROM patients WHERE id = 'contrast-check-patient'`,
      );
      expect(deleteResult.rowCount).toBe(1);
    });
  },
);

// Resolved via `require.resolve` and invoked with plain `node`, rather
// than `execFileSync('pnpm', ['exec', 'prisma', ...])`, so this never needs
// `shell: true` (Windows would otherwise require it, since `pnpm` itself
// is a shell shim there) — Node's own `child_process` docs flag
// `shell: true` plus an args array as unescaped string concatenation, a
// footgun worth avoiding even though every argument here is a fixed
// literal.
const PRISMA_CLI_ENTRY = require.resolve('prisma/build/index.js');

function runMigrateDeploy(databaseUrl: string): void {
  execFileSync(process.execPath, [PRISMA_CLI_ENTRY, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

function buildRuntimeDatabaseUrl(startedContainer: StartedPostgreSqlContainer): string {
  const host = startedContainer.getHost();
  const port = startedContainer.getPort();
  const database = startedContainer.getDatabase();
  return `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@${host}:${port}/${database}`;
}
