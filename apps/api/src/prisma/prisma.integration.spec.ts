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
// database, the runtime role can SELECT/INSERT but never UPDATE/DELETE
// `audit_events` (ADR-0011), the runtime role's ATTRIBUTES (not just its
// grants) are non-superuser (B3), every table's grant set matches what the
// migration declares (S9), and the boot-time privilege self-check (B4)
// actually distinguishes the runtime role from the owner role.
//
// Also covers the `fix/entered-measurement-system` follow-up migration
// (after P1.S3/P1.S4): `observations.entered_measurement_system` is
// NOT NULL with no default, and a new column on an existing table needs no
// new GRANT — both exercised by dedicated tests below rather than only
// asserted in design-specs/data-model/p1-s3-schema-coverage.md.
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaPg } from '@prisma/adapter-pg';
import type { AppConfig } from '../config/env.schema';
import { PrismaClient } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';

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
  // S10 (P1.S3 review response): a missing Docker daemon must never be a
  // silent, green skip in CI — `describe.skipIf` alone lets exactly that
  // happen, since a skipped suite still reports as "passed". Throwing here,
  // at module collection time, fails the whole file loudly instead, but
  // only when CI is actually expected to have a daemon; a developer
  // machine without Docker still gets the original clear-skip behavior.
  if (process.env.CI) {
    throw new Error(
      '[prisma.integration.spec.ts] Docker is not reachable, but CI is set — refusing to ' +
        'silently skip the audit-immutability proof (ADR-0002, ADR-0011). If this CI runner ' +
        'genuinely cannot provide a Docker daemon, that is a CI configuration defect to fix, ' +
        'not a reason to let this suite report green having proven nothing.',
    );
  }
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

// Every table this migration creates, and exactly which table-level
// privileges the runtime role should hold on each — the same set the
// migration's own GRANT statements declare. Kept here as an explicit,
// reviewable list (S9) rather than derived from the migration file itself,
// so this test fails the moment the two disagree, in either direction: a
// forgotten grant on a new table, or an over-grant nobody meant to add.
const EXPECTED_TABLE_GRANTS: Readonly<Record<string, readonly string[]>> = {
  patients: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  sync_operations: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  value_sets: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  clinical_default_ranges: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  validation_thresholds: ['DELETE', 'INSERT', 'SELECT', 'UPDATE'],
  // Tombstoned synced entities: no DELETE (S6).
  profiles: ['INSERT', 'SELECT', 'UPDATE'],
  observations: ['INSERT', 'SELECT', 'UPDATE'],
  effective_ranges: ['INSERT', 'SELECT', 'UPDATE'],
  // Retired-never-deleted (S5): no DELETE.
  value_set_members: ['INSERT', 'SELECT', 'UPDATE'],
  // Append-only (ADR-0011): SELECT and ordinary table-level INSERT — no
  // UPDATE/DELETE, ever. `occurred_at` being server-set is enforced by the
  // `audit_events_assign_occurred_at` trigger (S3, revised — see that
  // trigger's own comment in migration.sql for why this is NOT a
  // column-scoped grant), not by withholding any column from this grant.
  audit_events: ['INSERT', 'SELECT'],
};

describe.skipIf(!dockerAvailable)(
  'P1.S3 schema core — migration and runtime-role grants against real PostgreSQL',
  () => {
    let container: StartedPostgreSqlContainer;
    let ownerDatabaseUrl: string;
    let runtimeDatabaseUrl: string;
    let runtimeClient: PrismaClient;
    let ownerPrismaClient: PrismaClient;
    let plainRuntimePgClient: PgClient;
    let plainOwnerPgClient: PgClient;

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

      // "Applies cleanly to an empty database" — the first of this
      // sprint's own exit criteria. Deliberately run here, in `beforeAll`,
      // rather than inside an `it()`: every test below needs this to have
      // already happened, and S11 (below) is exactly about not hiding
      // that kind of setup-vs-assertion dependency inside a same-named
      // `it()` block. If this throws, `beforeAll` fails and every test in
      // this file is (correctly) reported as failed rather than passing
      // vacuously against an unmigrated database.
      runMigrateDeploy(ownerDatabaseUrl);

      // S11 (P1.S3 review response): setting the runtime role's password
      // and constructing the clients that use it used to live inside a
      // same-named `it()` block (test 3 of the original file), which meant
      // every later test silently depended on that one specific test
      // having already run, in order, in the same process — true today,
      // but not something the file's structure enforced or made visible.
      // Moved here so that dependency is structural (a `beforeAll` failure
      // fails every test in the file, loudly) rather than an unstated
      // ordering assumption a later refactor could break silently (e.g. by
      // running a filtered subset of tests with `-t`).
      const owner = new PgClient({ connectionString: ownerDatabaseUrl });
      await owner.connect();
      try {
        await owner.query(`ALTER ROLE "${RUNTIME_ROLE}" WITH LOGIN PASSWORD '${RUNTIME_PASSWORD}'`);
      } finally {
        await owner.end();
      }

      runtimeDatabaseUrl = buildDatabaseUrl(container, RUNTIME_ROLE, RUNTIME_PASSWORD);
      plainRuntimePgClient = new PgClient({ connectionString: runtimeDatabaseUrl });
      await plainRuntimePgClient.connect();
      plainOwnerPgClient = new PgClient({ connectionString: ownerDatabaseUrl });
      await plainOwnerPgClient.connect();

      runtimeClient = new PrismaClient({
        adapter: new PrismaPg({ connectionString: runtimeDatabaseUrl }),
      });
      ownerPrismaClient = new PrismaClient({
        adapter: new PrismaPg({ connectionString: ownerDatabaseUrl }),
      });
      // Lazy connection (see prisma.service.ts) — force it now so later
      // tests are asserting on the grant, not on connection setup latency.
      await runtimeClient.patient.findMany({ take: 0 });
      await ownerPrismaClient.patient.findMany({ take: 0 });
    }, 60_000);

    afterAll(async () => {
      await runtimeClient?.$disconnect();
      await ownerPrismaClient?.$disconnect();
      await plainRuntimePgClient?.end();
      await plainOwnerPgClient?.end();
      await container?.stop();
    });

    it('applied the initial migration cleanly to an empty database (exit criterion 1)', async () => {
      const result = await plainOwnerPgClient.query(
        `SELECT to_regclass('public.patients') AS patients_table, to_regclass('public.audit_events') AS audit_table`,
      );
      expect(result.rows[0]?.patients_table).toBe('patients');
      expect(result.rows[0]?.audit_table).toBe('audit_events');
    });

    it('re-applying the migration against an already-migrated, non-empty database is a clean no-op (the case that matters — docs/deployment-development.md)', async () => {
      // Populate it first — a real row, not just an already-applied
      // migration record — so this is genuinely the "existing rows" case
      // docs/deployment-development.md calls out, not merely Prisma's own
      // migration-history bookkeeping.
      await plainOwnerPgClient.query(
        `INSERT INTO patients (id, oidc_subject, updated_at) VALUES (gen_random_uuid(), 'populated-check-subject', now())`,
      );

      expect(() => runMigrateDeploy(ownerDatabaseUrl)).not.toThrow();

      const result = await plainOwnerPgClient.query(
        `SELECT id FROM patients WHERE oidc_subject = 'populated-check-subject'`,
      );
      expect(result.rowCount).toBe(1);
    });

    it('re-diffing the live, migrated database against schema.prisma is empty — the sync_sequence trigger fix holds (B1)', () => {
      // The specific regression this migration's header comment and
      // schema.prisma's `serverSequence` fields warn against: verified by
      // hand while fixing B1 that `migrate diff --from-config-datasource
      // --to-schema` against a live, migrated database (as opposed to
      // `--from-empty`, which is what generates the DDL in the first
      // place) proposed `DROP SEQUENCE "sync_sequence"` plus stripping the
      // `server_sequence` default on all three tables that carry one,
      // before this fix. This test pins that down permanently: a future
      // schema.prisma change that reintroduces
      // `@default(dbgenerated("nextval(...)"))` on any of those columns
      // will make this test fail with a non-empty diff, rather than the
      // regression only being caught the next time someone happens to run
      // `migrate dev` by hand.
      const output = execFileSync(
        process.execPath,
        [
          PRISMA_CLI_ENTRY,
          'migrate',
          'diff',
          '--from-config-datasource',
          '--to-schema',
          'prisma/schema.prisma',
          '--script',
        ],
        {
          cwd: API_ROOT,
          env: { ...process.env, MIGRATION_DATABASE_URL: ownerDatabaseUrl },
          encoding: 'utf-8',
        },
      );
      expect(output).toContain('This is an empty migration');
    });

    it("sets the runtime role's password the same way infra/db/bootstrap-roles.sql does — the migration only creates the role NOLOGIN (verifying beforeAll's own setup)", async () => {
      const result = await plainOwnerPgClient.query(
        `SELECT rolcanlogin FROM pg_roles WHERE rolname = $1`,
        [RUNTIME_ROLE],
      );
      expect(result.rows[0]?.rolcanlogin).toBe(true);
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

    it('overwrites a caller-supplied occurred_at on audit_events rather than storing it — server-set via trigger, not a column-scoped grant (S3, revised)', async () => {
      const backdated = await plainRuntimePgClient.query(
        `INSERT INTO audit_events (id, actor_type, actor_id, action, entity_type, entity_id, occurred_at)
         VALUES (gen_random_uuid(), 'SYSTEM', 'x', 'CREATE', 'x', 'x', now() - interval '1 day')
         RETURNING occurred_at`,
      );
      const storedOccurredAt = new Date(backdated.rows[0].occurred_at as string);
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      // Whatever the caller supplied ("yesterday"), the trigger stamped it
      // with the actual current time — recently, not a day ago.
      expect(storedOccurredAt.getTime()).toBeGreaterThan(oneHourAgo.getTime());
    });

    it('contrast case: the runtime role DOES hold full CRUD on an ordinary, non-tombstoned table (patients) — the audit restriction above is deliberate, not a blanket lockout', async () => {
      await plainRuntimePgClient.query(
        `INSERT INTO patients (id, oidc_subject, updated_at) VALUES (gen_random_uuid(), 'contrast-check-subject', now())`,
      );
      await plainRuntimePgClient.query(
        `UPDATE patients SET updated_at = now() WHERE oidc_subject = 'contrast-check-subject'`,
      );
      const deleteResult = await plainRuntimePgClient.query(
        `DELETE FROM patients WHERE oidc_subject = 'contrast-check-subject'`,
      );
      expect(deleteResult.rowCount).toBe(1);
    });

    it('refuses DELETE for the runtime role on every tombstoned synced entity, and on value_set_members (S5/S6)', async () => {
      for (const table of ['profiles', 'observations', 'effective_ranges', 'value_set_members']) {
        await expect(plainRuntimePgClient.query(`DELETE FROM "${table}"`)).rejects.toMatchObject({
          message: expect.stringContaining('permission denied'),
        });
      }
    });

    it("refuses changing a value_set_members row's code, even for the owner role — retired, never renumbered (S5)", async () => {
      const valueSet = await plainOwnerPgClient.query(
        `INSERT INTO value_sets (id, key, updated_at) VALUES (gen_random_uuid(), 'integration-test-set', now()) RETURNING id`,
      );
      const valueSetId = valueSet.rows[0].id;
      await plainOwnerPgClient.query(
        `INSERT INTO value_set_members (id, value_set_id, code, updated_at) VALUES (gen_random_uuid(), $1, 'original-code', now())`,
        [valueSetId],
      );

      await expect(
        plainOwnerPgClient.query(
          `UPDATE value_set_members SET code = 'renumbered' WHERE value_set_id = $1`,
          [valueSetId],
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining('immutable') });

      // Retiring (a status change, not a code change) is unaffected.
      const retireResult = await plainOwnerPgClient.query(
        `UPDATE value_set_members SET status = 'RETIRED', retired_at = now() WHERE value_set_id = $1`,
        [valueSetId],
      );
      expect(retireResult.rowCount).toBe(1);
    });

    it('rejects a non-canonical unit and accepts a canonical one on observations (S4)', async () => {
      const patient = await plainRuntimePgClient.query(
        `INSERT INTO patients (id, oidc_subject, updated_at) VALUES (gen_random_uuid(), 'unit-check-subject', now()) RETURNING id`,
      );
      const patientId = patient.rows[0].id;

      await expect(
        plainRuntimePgClient.query(
          `INSERT INTO observations (id, patient_id, code, value_quantity_value, value_quantity_unit, effective_datetime, entered_measurement_system, entered_timezone, local_date, client_updated_at, updated_at)
           VALUES (gen_random_uuid(), $1, '79560-9', 100, 'liters', now(), 'METRIC', 'America/Chicago', current_date, now(), now())`,
          [patientId],
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('observations_value_quantity_unit_check'),
      });

      const goodInsert = await plainRuntimePgClient.query(
        `INSERT INTO observations (id, patient_id, code, value_quantity_value, value_quantity_unit, effective_datetime, entered_measurement_system, entered_timezone, local_date, client_updated_at, updated_at)
         VALUES (gen_random_uuid(), $1, '79560-9', 100, 'mL', now(), 'METRIC', 'America/Chicago', current_date, now(), now())`,
        [patientId],
      );
      expect(goodInsert.rowCount).toBe(1);
    });

    it('rejects an INSERT that omits entered_measurement_system — NOT NULL, no default (P1.S3 follow-up: ADR-0005 entry-system column)', async () => {
      const patient = await plainRuntimePgClient.query(
        `INSERT INTO patients (id, oidc_subject, updated_at) VALUES (gen_random_uuid(), 'entry-system-required-subject', now()) RETURNING id`,
      );
      const patientId = patient.rows[0].id;

      await expect(
        plainRuntimePgClient.query(
          // Supplies the OTHER required provenance columns, so this
          // isolates `entered_measurement_system`. Postgres reports
          // whichever NOT NULL it reaches first, and a test that omitted
          // all three would pass while naming the wrong guarantee.
          `INSERT INTO observations (id, patient_id, code, value_quantity_value, value_quantity_unit, effective_datetime, entered_timezone, local_date, client_updated_at, updated_at)
           VALUES (gen_random_uuid(), $1, '79560-9', 100, 'mL', now(), 'America/Chicago', current_date, now(), now())`,
          [patientId],
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('entered_measurement_system'),
      });
    });

    it('rejects an INSERT that omits entered_timezone — NOT NULL, no default (ADR-0016)', async () => {
      /**
       * The same permanence argument as `entered_measurement_system`, and
       * the reason both are NOT NULL with no default: the stored instant
       * alone does not say where the patient was, so a row written without
       * a zone can never have its day recovered. Enforced by the column,
       * not by the write path, because a future write path that forgets is
       * exactly the failure this has to survive.
       */
      const patient = await plainRuntimePgClient.query(
        `INSERT INTO patients (id, oidc_subject, updated_at) VALUES (gen_random_uuid(), 'entered-timezone-required-subject', now()) RETURNING id`,
      );
      const patientId = patient.rows[0].id;

      await expect(
        plainRuntimePgClient.query(
          `INSERT INTO observations (id, patient_id, code, value_quantity_value, value_quantity_unit, effective_datetime, entered_measurement_system, local_date, client_updated_at, updated_at)
           VALUES (gen_random_uuid(), $1, '79560-9', 100, 'mL', now(), 'METRIC', current_date, now(), now())`,
          [patientId],
        ),
      ).rejects.toMatchObject({
        message: expect.stringContaining('entered_timezone'),
      });
    });

    it('lets the runtime role write and read entered_measurement_system with no extra grant needed — a new column on an existing table inherits the unqualified table-level grant (ADR-0011)', async () => {
      const patient = await plainRuntimePgClient.query(
        `INSERT INTO patients (id, oidc_subject, updated_at) VALUES (gen_random_uuid(), 'entry-system-grant-check-subject', now()) RETURNING id`,
      );
      const patientId = patient.rows[0].id;

      const inserted = await plainRuntimePgClient.query(
        `INSERT INTO observations (id, patient_id, code, value_quantity_value, value_quantity_unit, effective_datetime, entered_measurement_system, entered_timezone, local_date, client_updated_at, updated_at)
         VALUES (gen_random_uuid(), $1, '79560-9', 236.588, 'mL', now(), 'IMPERIAL', 'America/Chicago', current_date, now(), now())
         RETURNING entered_measurement_system`,
        [patientId],
      );
      expect(inserted.rows[0].entered_measurement_system).toBe('IMPERIAL');

      const selected = await plainRuntimePgClient.query(
        `SELECT entered_measurement_system FROM observations WHERE patient_id = $1`,
        [patientId],
      );
      expect(selected.rows[0].entered_measurement_system).toBe('IMPERIAL');
    });

    it('the sync-sequence trigger assigns strictly increasing server_sequence values across tables, unconditionally overwriting whatever the caller supplied (B1)', async () => {
      const patient = await plainRuntimePgClient.query(
        `INSERT INTO patients (id, oidc_subject, updated_at) VALUES (gen_random_uuid(), 'sequence-check-subject', now()) RETURNING id`,
      );
      const patientId = patient.rows[0].id;

      const first = await plainRuntimePgClient.query(
        `INSERT INTO observations (id, patient_id, code, value_quantity_value, value_quantity_unit, effective_datetime, entered_measurement_system, entered_timezone, local_date, client_updated_at, updated_at, server_sequence)
         VALUES (gen_random_uuid(), $1, '79560-9', 100, 'mL', now(), 'METRIC', 'America/Chicago', current_date, now(), now(), 999999)
         RETURNING server_sequence`,
        [patientId],
      );
      const second = await plainRuntimePgClient.query(
        `INSERT INTO observations (id, patient_id, code, value_quantity_value, value_quantity_unit, effective_datetime, entered_measurement_system, entered_timezone, local_date, client_updated_at, updated_at, server_sequence)
         VALUES (gen_random_uuid(), $1, '79560-9', 100, 'mL', now(), 'METRIC', 'America/Chicago', current_date, now(), now(), 999999)
         RETURNING server_sequence`,
        [patientId],
      );

      // Neither row kept the caller-supplied 999999 — the trigger
      // overwrote both, and the second is strictly greater than the
      // first, proving a single shared sequence is actually being drawn
      // from rather than two independent per-table ones.
      expect(Number(first.rows[0].server_sequence)).not.toBe(999999);
      expect(Number(second.rows[0].server_sequence)).toBeGreaterThan(
        Number(first.rows[0].server_sequence),
      );
    });

    it('holds NOSUPERUSER/NOCREATEDB/NOCREATEROLE/NOINHERIT/NOREPLICATION/NOBYPASSRLS and no role membership — attributes, not just grants (B3)', async () => {
      const attributes = await plainOwnerPgClient.query(
        `SELECT rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls
         FROM pg_roles WHERE rolname = $1`,
        [RUNTIME_ROLE],
      );
      expect(attributes.rows[0]).toMatchObject({
        rolsuper: false,
        rolcreatedb: false,
        rolcreaterole: false,
        rolinherit: false,
        rolreplication: false,
        rolbypassrls: false,
      });

      // A `GRANT some_role TO ostomy_runtime` would let application code
      // `SET ROLE` to whatever that grants membership in — including the
      // owner role — regardless of NOINHERIT (which only controls whether
      // the granted privileges apply automatically; it does not prevent an
      // explicit `SET ROLE`). No membership row at all is what actually
      // forecloses that (B3).
      const membership = await plainOwnerPgClient.query(
        `SELECT 1 FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = $1)`,
        [RUNTIME_ROLE],
      );
      expect(membership.rowCount).toBe(0);
    });

    it('every application table grants the runtime role exactly the privileges the migration declares, and _prisma_migrations grants it none (S9)', async () => {
      const grants = await plainOwnerPgClient.query(
        `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_schema = 'public'
         ORDER BY table_name, privilege_type`,
        [RUNTIME_ROLE],
      );

      const grantedByTable = new Map<string, string[]>();
      for (const row of grants.rows as Array<{ table_name: string; privilege_type: string }>) {
        const existing = grantedByTable.get(row.table_name) ?? [];
        existing.push(row.privilege_type);
        grantedByTable.set(row.table_name, existing);
      }

      for (const [table, expectedPrivileges] of Object.entries(EXPECTED_TABLE_GRANTS)) {
        expect(grantedByTable.get(table)?.sort(), `table_name=${table}`).toEqual(
          [...expectedPrivileges].sort(),
        );
      }

      // Every table this migration creates must appear in
      // EXPECTED_TABLE_GRANTS above — this is the "forgot the GRANT line
      // for a new table" failure mode ADR-0011 names explicitly, made a
      // hard test failure instead of a runtime "permission denied"
      // discovered later.
      const allTables = await plainOwnerPgClient.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`,
      );
      const actualTableNames = (allTables.rows as Array<{ tablename: string }>)
        .map((row) => row.tablename)
        .sort();
      expect(actualTableNames).toEqual(Object.keys(EXPECTED_TABLE_GRANTS).sort());

      // _prisma_migrations: the runtime role must never be able to see or
      // touch Prisma's own migration-history bookkeeping table.
      const migrationsTableGrants = await plainOwnerPgClient.query(
        `SELECT 1 FROM information_schema.role_table_grants
         WHERE grantee = $1 AND table_schema = 'public' AND table_name = '_prisma_migrations'`,
        [RUNTIME_ROLE],
      );
      expect(migrationsTableGrants.rowCount).toBe(0);
    });

    it('assertRuntimeRoleIsNotOverPrivileged() resolves for the runtime role and throws for the owner role (B4)', async () => {
      const runtimePrismaService = buildPrismaServiceForTest(runtimeDatabaseUrl);
      try {
        await expect(
          runtimePrismaService.assertRuntimeRoleIsNotOverPrivileged(),
        ).resolves.toBeUndefined();
      } finally {
        await runtimePrismaService.$disconnect();
      }

      const ownerPrismaService = buildPrismaServiceForTest(ownerDatabaseUrl);
      try {
        await expect(ownerPrismaService.assertRuntimeRoleIsNotOverPrivileged()).rejects.toThrow(
          /UPDATE or DELETE audit_events/,
        );
      } finally {
        await ownerPrismaService.$disconnect();
      }
    });

    it('assertRuntimeRoleIsNotOverPrivileged() throws when the runtime role holds only TRUNCATE on audit_events (S7)', async () => {
      // The exact gap S7 closes: a role with neither UPDATE nor DELETE, only
      // TRUNCATE — a future over-granting migration's plausible mistake,
      // since TRUNCATE is easy to reach for when "clear this table" is the
      // intent without meaning to grant row-level DML. TRUNCATE empties the
      // whole append-only table in one statement regardless.
      const grantOwner = new PgClient({ connectionString: ownerDatabaseUrl });
      await grantOwner.connect();
      try {
        await grantOwner.query(`GRANT TRUNCATE ON audit_events TO "${RUNTIME_ROLE}"`);
      } finally {
        await grantOwner.end();
      }

      try {
        const runtimePrismaService = buildPrismaServiceForTest(runtimeDatabaseUrl);
        try {
          await expect(runtimePrismaService.assertRuntimeRoleIsNotOverPrivileged()).rejects.toThrow(
            /UPDATE or DELETE audit_events/,
          );
        } finally {
          await runtimePrismaService.$disconnect();
        }
      } finally {
        // Revoked again rather than left granted — this is the last test in
        // the file today, but leaving a stray grant in place is exactly the
        // kind of state a future reordering could depend on by accident.
        const revokeOwner = new PgClient({ connectionString: ownerDatabaseUrl });
        await revokeOwner.connect();
        try {
          await revokeOwner.query(`REVOKE TRUNCATE ON audit_events FROM "${RUNTIME_ROLE}"`);
        } finally {
          await revokeOwner.end();
        }
      }
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
    // MIGRATION_DATABASE_URL, not DATABASE_URL (S12) — this subprocess runs
    // the same CLI apps/api/prisma.config.ts configures, which reads that
    // variable name specifically so it can never be confused with the
    // runtime role's DSN. See that file's own comment.
    env: { ...process.env, MIGRATION_DATABASE_URL: databaseUrl },
    stdio: 'pipe',
  });
}

function buildDatabaseUrl(
  startedContainer: StartedPostgreSqlContainer,
  user: string,
  password: string,
): string {
  const host = startedContainer.getHost();
  const port = startedContainer.getPort();
  const database = startedContainer.getDatabase();
  return `postgresql://${user}:${password}@${host}:${port}/${database}`;
}

/**
 * Builds a `PrismaService` outside Nest's DI container, for tests that
 * only need `assertRuntimeRoleIsNotOverPrivileged()` and never touch
 * anything else `AppConfig` provides. `@Inject`/`@Injectable` are
 * DI-container metadata only — they do not stop a plain `new
 * PrismaService(...)` call — but the constructor's parameter is typed as
 * the full `AppConfig`, so this casts a minimal object rather than
 * constructing every unrelated field (OIDC, object storage, ...) this test
 * has no reason to care about.
 */
function buildPrismaServiceForTest(databaseUrl: string): PrismaService {
  return new PrismaService({ databaseUrl } as AppConfig);
}
