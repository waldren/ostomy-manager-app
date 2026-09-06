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
 * P1.S5's fifth exit criterion, demonstrated end to end rather than only at
 * the unit level: `main.ts`'s real `bootstrap()` — spawned as a genuine
 * child process, exactly the way `pnpm start:dev`/`pnpm start` runs it, not
 * merely `PrismaService.assertRuntimeRoleIsNotOverPrivileged()` called
 * directly (that method's own behaviour is already proven by
 * `prisma.integration.spec.ts`'s "resolves for the runtime role and throws
 * for the owner role (B4)" test). What is new here, and what
 * `prisma.integration.spec.ts` cannot prove on its own, is that `main.ts`
 * actually WIRES that call into the boot sequence, before `app.listen()`
 * ever opens a port.
 *
 * `main.ts` has no exported `bootstrap()` to call in-process (it runs
 * immediately on import, matching every other Node entrypoint script in
 * this repo) — spawning it as a child process is therefore the only way to
 * exercise it as written, not a workaround.
 */
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const API_ROOT = path.resolve(__dirname, '..');

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
      '[bootstrap-privilege-check.integration.spec.ts] Docker is not reachable, but CI is set — ' +
        'refusing to silently skip.',
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    '[bootstrap-privilege-check.integration.spec.ts] Docker is not reachable — skipping. Run with ' +
      'a Docker daemon available (e.g. `pnpm --filter @ostomy/api test:integration`) to exercise ' +
      'this suite.',
  );
}

const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'bootstrap-integration-test-only-password';

/**
 * A fixed, high, unlikely-to-collide port — not 0 (an OS-assigned ephemeral
 * port), because the "reaches a listening state" assertion below confirms
 * readiness by actually polling `GET /api/v1/health` over real HTTP rather
 * than pattern-matching a log line, and doing that needs a port number known
 * in advance.
 */
const TEST_PORT = 34579;

/** The env vars every spawn below shares, distinct from `databaseUrl` (the one that varies per test). */
function sharedEnv(databaseUrl: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(TEST_PORT),
    LOG_LEVEL: 'info',
    OIDC_CLOCK_TOLERANCE_SECONDS: '30',
    DATABASE_URL: databaseUrl,
    OIDC_ISSUER: 'https://mock-oidc.test/patient-issuer',
    OIDC_JWKS_URI: 'https://mock-oidc.test/patient-issuer/jwks',
    OIDC_AUDIENCE: 'ostomy-patient-app',
    OIDC_SUBJECT_CLAIM: 'sub',
    ADMIN_OIDC_ISSUER: 'https://mock-oidc.test/admin-issuer',
    ADMIN_OIDC_JWKS_URI: 'https://mock-oidc.test/admin-issuer/jwks',
    ADMIN_OIDC_AUDIENCE: 'ostomy-admin-console',
    ADMIN_OIDC_SUBJECT_CLAIM: 'sub',
    OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
    OBJECT_STORAGE_REGION: 'us-east-1',
    OBJECT_STORAGE_ACCESS_KEY_ID: 'test-access-key',
    OBJECT_STORAGE_SECRET_ACCESS_KEY: 'test-secret-key',
    OBJECT_STORAGE_FORCE_PATH_STYLE: 'true',
  };
}

describe.skipIf(!dockerAvailable)(
  "main.ts's real bootstrap() — spawned as a child process, real PostgreSQL (ADR-0011)",
  () => {
    let container: StartedPostgreSqlContainer;
    let ownerDatabaseUrl: string;
    let runtimeDatabaseUrl: string;

    beforeAll(async () => {
      container = await new PostgreSqlContainer('postgres:17-alpine')
        .withDatabase('ostomy_bootstrap_test')
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

      const host = container.getHost();
      const port = container.getPort();
      const database = container.getDatabase();
      runtimeDatabaseUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@${host}:${port}/${database}`;
    }, 90_000);

    afterAll(async () => {
      await container?.stop();
    });

    it('fails startup, before listening, when DATABASE_URL is the over-privileged owner role', async () => {
      const result = await runBootstrap(sharedEnv(ownerDatabaseUrl));

      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain('UPDATE or DELETE audit_events');
      // Never actually opened a port — the check runs before app.listen().
      expect(result.output).not.toMatch(/listening|nest application successfully started/i);
    }, 30_000);

    it('passes the check and reaches a listening state when DATABASE_URL is the constrained runtime role', async () => {
      const result = await runBootstrapUntilListeningOrTimeout(
        sharedEnv(runtimeDatabaseUrl),
        20_000,
      );

      expect(result.reachedListening).toBe(true);
      expect(result.output).not.toContain('UPDATE or DELETE audit_events');
    }, 30_000);
  },
);

interface BootstrapResult {
  exitCode: number | null;
  output: string;
}

/** Runs `tsx src/main.ts` to completion (it is expected to exit on its own — the privilege check fails before `app.listen()` ever keeps the process alive). */
function runBootstrap(env: NodeJS.ProcessEnv): Promise<BootstrapResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve('tsx/cli'), 'src/main.ts'], {
      cwd: API_ROOT,
      env,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('exit', (exitCode) => resolve({ exitCode, output }));
  });
}

interface ListeningResult {
  reachedListening: boolean;
  output: string;
}

/**
 * Runs `tsx src/main.ts` and polls `GET /api/v1/health` over real HTTP until
 * it responds or a timeout elapses — this is the "startup succeeds" contrast
 * case, so the process is expected to keep running (a real HTTP listener),
 * not exit on its own. A real HTTP round trip is a stronger readiness signal
 * than pattern-matching a log line, and does not depend on the exact wording
 * of whichever framework/logger happens to print a startup message. Killed
 * explicitly once the assertion has what it needs.
 */
async function runBootstrapUntilListeningOrTimeout(
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<ListeningResult> {
  const child = spawn(process.execPath, [require.resolve('tsx/cli'), 'src/main.ts'], {
    cwd: API_ROOT,
    env,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));

  const deadline = Date.now() + timeoutMs;
  let reachedListening = false;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        // The process already exited (e.g. the privilege check somehow
        // still fired) — no point continuing to poll a port nothing is
        // bound to.
        break;
      }
      try {
        const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/v1/health`);
        if (response.status === 200) {
          reachedListening = true;
          break;
        }
      } catch {
        // Not listening yet — expected during startup; keep polling.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    child.kill();
  }

  return { reachedListening, output };
}
