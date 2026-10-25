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

// P4.S6 (#168): the two one-off database tasks' scripts (infra/cdk/tasks),
// run as the stack runs them, against PostgreSQL 17 with a master user shaped
// like RDS's: CREATEROLE and CREATEDB, not a superuser. The master's limits
// are the point: on PostgreSQL 16+ it may not create a database owned by a
// role it cannot SET ROLE to, which is why the owner creates its own.
//
// What the migrations then do under that owner is
// apps/api/src/prisma/managed-owner.integration.spec.ts's to prove; here the
// runtime role is created by hand, as the first migration would create it.
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const TASKS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'tasks');

const MASTER = { user: 'ostomy_master', password: 'master-test-only-password' };
const OWNER_ROLE = 'ostomy_owner';
const OWNER_PASSWORD = 'owner-test-only-password';
const RUNTIME_ROLE = 'ostomy_runtime';
const DB_NAME = 'ostomy';

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
  // Never a silent green skip in CI: see apps/api's prisma.integration.spec.ts (S10).
  if (process.env.CI) {
    throw new Error(
      '[db-tasks.integration.spec.ts] Docker is not reachable, but CI is set; refusing to skip.',
    );
  }
  // Test-runner diagnostics, not application logging.
  console.warn('[db-tasks.integration.spec.ts] Docker is not reachable; skipping.');
}

describe.skipIf(!dockerAvailable)('the one-off database tasks (P4.S6, #168)', () => {
  let container: StartedPostgreSqlContainer;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('postgres')
      .withUsername('bootstrap_superuser')
      .withPassword('bootstrap-test-only-password')
      .start();
    await query({ user: 'bootstrap_superuser', password: 'bootstrap-test-only-password' }, [
      `CREATE ROLE ${MASTER.user} LOGIN PASSWORD '${MASTER.password}' CREATEROLE CREATEDB`,
    ]);
  }, 120_000);

  afterAll(async () => {
    await container?.stop();
  });

  async function query(
    login: { user: string; password: string },
    sql: string[],
    database = 'postgres',
  ): Promise<pg.QueryResult[]> {
    const client = new pg.Client({
      host: container.getHost(),
      port: container.getPort(),
      database,
      ...login,
    });
    await client.connect();
    try {
      const results: pg.QueryResult[] = [];
      for (const statement of sql) results.push(await client.query(statement));
      return results;
    } finally {
      await client.end();
    }
  }

  function runTask(script: string, env: Record<string, string>) {
    const result = spawnSync(process.execPath, [path.join(TASKS, script)], {
      env: {
        PATH: process.env.PATH ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        DB_HOST: container.getHost(),
        DB_PORT: String(container.getPort()),
        DB_TLS: 'off',
        ...env,
      },
      encoding: 'utf8',
    });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  const bootstrapEnv = (overrides: Record<string, string> = {}) => ({
    DB_MASTER_USER: MASTER.user,
    DB_MASTER_PASSWORD: MASTER.password,
    DB_OWNER_ROLE: OWNER_ROLE,
    DB_OWNER_PASSWORD: OWNER_PASSWORD,
    DB_NAME,
    ...overrides,
  });

  it('db-bootstrap: creates the owner as ADR-0011 describes it, and its own database', async () => {
    const { status, output } = runTask('db-bootstrap.cjs', bootstrapEnv());
    expect(output).toContain(`created role ${OWNER_ROLE}`);
    expect(output).toContain(`created database ${DB_NAME}`);
    expect(status).toBe(0);

    const [roles, databases, memberships] = await query(MASTER, [
      `SELECT rolcanlogin, rolcreaterole, rolcreatedb, rolsuper, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = '${OWNER_ROLE}'`,
      `SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = '${DB_NAME}'`,
      `SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = '${OWNER_ROLE}')`,
    ]);
    expect(roles?.rows[0]).toEqual({
      rolcanlogin: true,
      rolcreaterole: true,
      rolcreatedb: true,
      rolsuper: false,
      rolreplication: false,
      rolbypassrls: false,
    });
    expect(databases?.rows[0]).toEqual({ owner: OWNER_ROLE });
    // The owner is a member of nothing, so it carries no privilege it was not given.
    expect(memberships?.rowCount).toBe(0);
  });

  it('db-bootstrap: a re-run succeeds and rotates the owner password', async () => {
    const rotated = 'owner-rotated-test-only-password';
    const { status, output } = runTask(
      'db-bootstrap.cjs',
      bootstrapEnv({ DB_OWNER_PASSWORD: rotated }),
    );
    expect(output).toContain(`updated role ${OWNER_ROLE}`);
    expect(output).toContain(`database ${DB_NAME} already exists`);
    expect(status).toBe(0);
    await expect(
      query({ user: OWNER_ROLE, password: rotated }, ['SELECT 1']),
    ).resolves.toBeDefined();

    // Put it back for the tests that follow.
    expect(runTask('db-bootstrap.cjs', bootstrapEnv()).status).toBe(0);
  });

  it('runtime-password: gives the runtime role its LOGIN and password, as the owner', async () => {
    // As the first migration does: created by the owner, NOLOGIN, no password.
    await query(
      { user: OWNER_ROLE, password: OWNER_PASSWORD },
      [
        `CREATE ROLE ${RUNTIME_ROLE} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOLOGIN`,
      ],
      DB_NAME,
    );
    const runtimePassword = 'runtime-test-only-password';

    const { status, output } = runTask('runtime-password.cjs', {
      DB_OWNER_ROLE: OWNER_ROLE,
      DB_OWNER_PASSWORD: OWNER_PASSWORD,
      DB_RUNTIME_ROLE: RUNTIME_ROLE,
      DB_RUNTIME_PASSWORD: runtimePassword,
      DB_NAME,
    });
    expect(output).toContain(`set the password for ${RUNTIME_ROLE}`);
    expect(status).toBe(0);

    const [whoami] = await query(
      { user: RUNTIME_ROLE, password: runtimePassword },
      ['SELECT current_user AS who'],
      DB_NAME,
    );
    expect(whoami?.rows[0]).toEqual({ who: RUNTIME_ROLE });
  });

  it('refuses to connect in the clear unless told to, and names the missing setting', () => {
    const { status, output } = runTask('db-bootstrap.cjs', {
      ...bootstrapEnv(),
      DB_TLS: '',
    });
    expect(status).toBe(1);
    expect(output).toContain('DB_SSL_CA_FILE is required');
  });

  it('never prints a password when it fails', () => {
    const wrong = 'not-the-master-password';
    const { status, output } = runTask(
      'db-bootstrap.cjs',
      bootstrapEnv({ DB_MASTER_PASSWORD: wrong }),
    );
    expect(status).toBe(1);
    expect(output).toMatch(/^failed: /m);
    expect(output).not.toContain(wrong);
    expect(output).not.toContain(OWNER_PASSWORD);
  });
});
