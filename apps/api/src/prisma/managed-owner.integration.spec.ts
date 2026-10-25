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

// P4.S6 (#168): the migrations, run by an owner shaped like a managed
// database's. Every other integration spec migrates as the Postgres image's
// bootstrap SUPERUSER, which is not what RDS gives you: its master user holds
// CREATEROLE and CREATEDB and is not a superuser. Under that owner the first
// migration failed outright ("Only roles with the SUPERUSER attribute may
// change the SUPERUSER attribute"), and nothing in CI could have said so.
//
// What this proves, on a fresh cluster: every migration applies; the owner
// can set the runtime role's password (the step `infra/db/bootstrap-roles.sql`
// and the staging task perform); the runtime role holds none of the
// attributes that would make its grants decorative; and the API's boot-time
// privilege check passes for it and refuses the owner. And the guard that
// replaced the unconditional ALTER ROLE for such an owner: a runtime role
// that already exists with an unsafe attribute, or with any role membership
// (under either owner), refuses the migration.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppConfig } from '../config/env.schema';
import { PrismaService } from './prisma.service';

const API_ROOT = path.resolve(__dirname, '..', '..');
const PRISMA_CLI_ENTRY = require.resolve('prisma/build/index.js');

const OWNER = 'managed_owner';
const OWNER_PASSWORD = 'owner-test-only-password';
const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'runtime-test-only-password';

/** See prisma.integration.spec.ts's copy for why this runs at collection time. */
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
  // Never a silent green skip in CI: see prisma.integration.spec.ts (S10).
  if (process.env.CI) {
    throw new Error(
      '[managed-owner.integration.spec.ts] Docker is not reachable, but CI is set; refusing to ' +
        'skip the proof that the migrations run under a managed-database owner.',
    );
  }
  // Test-runner diagnostics, not application logging.
  // eslint-disable-next-line no-console
  console.warn(
    '[managed-owner.integration.spec.ts] Docker is not reachable; skipping the managed-owner migration tests.',
  );
}

function runMigrateDeploy(databaseUrl: string): void {
  execFileSync(process.execPath, [PRISMA_CLI_ENTRY, 'migrate', 'deploy'], {
    cwd: API_ROOT,
    env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

/** The migration's stderr, which is where Prisma reports a failed statement. */
function migrateDeployFailure(databaseUrl: string): string {
  try {
    runMigrateDeploy(databaseUrl);
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: Buffer; stderr?: Buffer };
    return `${stdout?.toString() ?? ''}${stderr?.toString() ?? ''}`;
  }
  throw new Error('expected the migration to fail');
}

function url(container: StartedPostgreSqlContainer, user: string, password: string, db: string) {
  return `postgresql://${user}:${password}@${container.getHost()}:${container.getPort()}/${db}`;
}

async function asSuperuser(container: StartedPostgreSqlContainer, sql: string[]): Promise<void> {
  const client = new PgClient({ connectionString: container.getConnectionUri() });
  await client.connect();
  try {
    for (const statement of sql) await client.query(statement);
  } finally {
    await client.end();
  }
}

/** A fresh cluster with a CREATEROLE, CREATEDB, non-superuser owner and its own database. */
async function startManagedShapedCluster(): Promise<StartedPostgreSqlContainer> {
  const container = await new PostgreSqlContainer('postgres:17-alpine')
    .withDatabase('bootstrap')
    .withUsername('bootstrap_superuser')
    .withPassword('bootstrap-test-only-password')
    .start();
  await asSuperuser(container, [
    `CREATE ROLE ${OWNER} LOGIN PASSWORD '${OWNER_PASSWORD}' CREATEDB CREATEROLE`,
    `CREATE DATABASE ostomy OWNER ${OWNER}`,
  ]);
  return container;
}

describe.skipIf(!dockerAvailable)('migrations under a managed-database owner (P4.S6, #168)', () => {
  describe('on a fresh cluster', () => {
    let container: StartedPostgreSqlContainer;
    let ownerUrl: string;
    let runtimeUrl: string;

    beforeAll(async () => {
      container = await startManagedShapedCluster();
      ownerUrl = url(container, OWNER, OWNER_PASSWORD, 'ostomy');
      runtimeUrl = url(container, RUNTIME_ROLE, RUNTIME_PASSWORD, 'ostomy');

      // The precondition that makes this test mean anything.
      const owner = new PgClient({ connectionString: ownerUrl });
      await owner.connect();
      try {
        const { rows } = await owner.query<{ rolsuper: boolean }>(
          'SELECT rolsuper FROM pg_roles WHERE rolname = current_user',
        );
        expect(rows[0]?.rolsuper).toBe(false);
      } finally {
        await owner.end();
      }

      runMigrateDeploy(ownerUrl);
    }, 120_000);

    afterAll(async () => {
      await container?.stop();
    });

    it('applies every migration, and the owner can set the runtime password', async () => {
      const owner = new PgClient({ connectionString: ownerUrl });
      await owner.connect();
      try {
        const pending = await owner.query(
          'SELECT 1 FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL',
        );
        expect(pending.rowCount).toBe(0);
        await owner.query(`ALTER ROLE "${RUNTIME_ROLE}" WITH LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
      } finally {
        await owner.end();
      }
    });

    it('leaves the runtime role with none of the attributes that defeat its grants', async () => {
      const client = new PgClient({ connectionString: ownerUrl });
      await client.connect();
      try {
        const { rows } = await client.query(
          `SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = $1`,
          [RUNTIME_ROLE],
        );
        expect(rows[0]).toEqual({
          rolsuper: false,
          rolcreatedb: false,
          rolcreaterole: false,
          rolinherit: false,
          rolreplication: false,
          rolbypassrls: false,
        });
        // The runtime role is a member of nothing, so it cannot SET ROLE to
        // anything. (PostgreSQL 16+ makes the CREATING owner a member of the
        // new role, the opposite direction, which grants the runtime nothing.)
        const membership = await client.query(
          'SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)',
          [RUNTIME_ROLE],
        );
        expect(membership.rowCount).toBe(0);
      } finally {
        await client.end();
      }
    });

    it("passes the API's boot-time privilege check as the runtime role, and refuses the owner", async () => {
      const runtime = new PrismaService({ databaseUrl: runtimeUrl } as AppConfig);
      const owner = new PrismaService({ databaseUrl: ownerUrl } as AppConfig);
      try {
        await expect(runtime.assertRuntimeRoleIsNotOverPrivileged()).resolves.toBeUndefined();
        await expect(owner.assertRuntimeRoleIsNotOverPrivileged()).rejects.toThrow(
          /Refusing to start/,
        );
      } finally {
        await runtime.$disconnect();
        await owner.$disconnect();
      }
    });
  });

  describe('when the runtime role already exists', () => {
    let container: StartedPostgreSqlContainer;

    beforeAll(async () => {
      container = await startManagedShapedCluster();
    }, 120_000);

    afterAll(async () => {
      await container?.stop();
    });

    /** A fresh `ostomy` database, and the runtime role pre-created by the superuser. */
    async function preProvision(roleSql: string, extra: string[] = []): Promise<void> {
      await asSuperuser(container, [
        'DROP DATABASE IF EXISTS ostomy',
        `DROP ROLE IF EXISTS "${RUNTIME_ROLE}"`,
        `CREATE ROLE "${RUNTIME_ROLE}" NOLOGIN ${roleSql}`,
        ...extra,
        `CREATE DATABASE ostomy OWNER ${OWNER}`,
      ]);
    }

    // All six, each alone: dropping any one from the migration's OR chain
    // must fail here.
    it.each([
      ['SUPERUSER'],
      ['CREATEDB'],
      ['CREATEROLE'],
      ['INHERIT'],
      ['REPLICATION'],
      ['BYPASSRLS'],
    ])(
      'refuses the migration for a role with %s, which this owner cannot remove',
      async (attribute) => {
        // CREATE ROLE defaults to INHERIT, so every other case names
        // NOINHERIT; without it each would be caught by INHERIT alone.
        await preProvision(attribute === 'INHERIT' ? 'INHERIT' : `NOINHERIT ${attribute}`);

        const output = migrateDeployFailure(url(container, OWNER, OWNER_PASSWORD, 'ostomy'));

        expect(output).toMatch(
          /ostomy_runtime already exists with an attribute that defeats its grants/,
        );
      },
      120_000,
    );

    // #170 review: clean attributes, but a membership it could SET ROLE through.
    it('refuses the migration for a role that is a member of another role', async () => {
      await preProvision('NOINHERIT', [`GRANT ${OWNER} TO "${RUNTIME_ROLE}"`]);

      const output = migrateDeployFailure(url(container, OWNER, OWNER_PASSWORD, 'ostomy'));

      expect(output).toMatch(/ostomy_runtime is a member of another role/);
    }, 120_000);

    it('refuses it under a superuser owner too, which could otherwise only fix the attributes', async () => {
      await preProvision('NOINHERIT', [`GRANT ${OWNER} TO "${RUNTIME_ROLE}"`]);

      const output = migrateDeployFailure(
        url(container, 'bootstrap_superuser', 'bootstrap-test-only-password', 'ostomy'),
      );

      expect(output).toMatch(/ostomy_runtime is a member of another role/);
    }, 120_000);

    // The branch the dev stack and the rest of the integration suite take:
    // still CORRECTS an unsafe role rather than refusing it.
    it('under a superuser owner, removes the unsafe attributes instead', async () => {
      await preProvision('INHERIT CREATEDB BYPASSRLS');

      runMigrateDeploy(
        url(container, 'bootstrap_superuser', 'bootstrap-test-only-password', 'ostomy'),
      );

      const client = new PgClient({
        connectionString: url(container, OWNER, OWNER_PASSWORD, 'ostomy'),
      });
      await client.connect();
      try {
        const { rows } = await client.query(
          `SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
           FROM pg_roles WHERE rolname = $1`,
          [RUNTIME_ROLE],
        );
        expect(Object.values(rows[0] as object)).toEqual([
          false,
          false,
          false,
          false,
          false,
          false,
        ]);
      } finally {
        await client.end();
      }
    }, 120_000);
  });
});
