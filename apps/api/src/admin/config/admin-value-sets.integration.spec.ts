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
 * P3.S3, ADR-0008. Against real PostgreSQL, as the runtime role.
 *
 * Integration rather than unit, because every guarantee worth testing here is a
 * database guarantee: that the configuration change and its audit row share one
 * transaction, that retirement is a status and not a delete, that the runtime role
 * cannot delete a member, and that a write is felt by the patient-facing read path.
 * Mocking `$transaction` would assert the shape of my own mock.
 *
 * The wire contract is unit-tested separately (`admin-value-set-wire.spec.ts`) because
 * this suite skips itself when Docker is unreachable, so anything that can be proven
 * without a database should not live here.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../audit/audit.service';
import { PrismaClient } from '../../generated/prisma/client';
import { ThresholdsService } from '../../thresholds/thresholds.service';

import { AdminValueSetsService, VALUE_SET_MEMBER_ENTITY_TYPE } from './admin-value-sets.service';

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
      '[admin-value-sets.integration.spec.ts] Docker is not reachable, but CI is set — refusing ' +
        'to silently skip. This suite is the only proof the admin audit row is written in the ' +
        'same transaction as the configuration change.',
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    '[admin-value-sets.integration.spec.ts] Docker is not reachable — skipping. Nothing else ' +
      'covers the audit-in-transaction guarantee.',
  );
}

const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'admin-value-sets-integration-test-only-password';
const ADMIN_SUBJECT = 'admin-integration-subject';
const SET_KEY = 'container_size';
/**
 * A set no shipped client renders, inserted by this suite.
 *
 * `PUBLISHED_VALUE_SET_KEYS` in `value-sets.controller.ts` names the four a patient
 * client may render, and the table currently holds exactly those four — so without
 * this, the admin surface's "shows unpublished sets too" behaviour has nothing to
 * demonstrate against.
 */
const UNPUBLISHED_SET_KEY = 'p3s3_unpublished_probe_set';

describe.skipIf(!dockerAvailable)('AdminValueSetsService — real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let service: AdminValueSetsService;
  /** Held so the cache-invalidation tests can read through the patient-facing path. */
  let thresholds: ThresholdsService;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('ostomy_admin_config_test')
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
      // Belt and braces: the P3.S1 migration already creates this set and seeds its
      // members, which is what makes the "code the deployment already defines" test
      // meaningful. Kept so the suite still runs if that migration ever stops seeding,
      // and `DO NOTHING` so it never fights the migration for ownership.
      await owner.query(
        `INSERT INTO value_sets (id, key, description, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'Quick-select container sizes', now(), now())
         ON CONFLICT (key) DO NOTHING`,
        [SET_KEY],
      );
      await owner.query(
        `INSERT INTO value_sets (id, key, description, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'A set no client publishes', now(), now())
         ON CONFLICT (key) DO NOTHING`,
        [UNPUBLISHED_SET_KEY],
      );
    } finally {
      await owner.end();
    }

    const runtimeDatabaseUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@${container.getHost()}:${String(container.getPort())}/ostomy_admin_config_test`;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeDatabaseUrl }) });

    // A 60s TTL, so anything these tests observe as fresh is the result of an explicit
    // invalidation rather than the TTL quietly expiring under them.
    thresholds = new ThresholdsService(prisma as never, 60_000);
    service = new AdminValueSetsService(
      prisma as never,
      new AuditService(prisma as never) as never,
      thresholds as never,
    );
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  async function auditRowsFor(memberId: string) {
    return prisma.auditEvent.findMany({
      where: { entityType: VALUE_SET_MEMBER_ENTITY_TYPE, entityId: memberId },
      orderBy: { occurredAt: 'asc' },
    });
  }

  it('records a CREATE carrying the admin identity and the new state', async () => {
    const write = await service.addMember(
      SET_KEY,
      { code: 'p3s3_probe_created', sortOrder: 10, numericValue: 250, numericUnit: 'mL' },
      ADMIN_SUBJECT,
      undefined,
    );

    const rows = await auditRowsFor(write.memberId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actorType).toBe('ADMIN');
    expect(rows[0]!.actorId).toBe(ADMIN_SUBJECT);
    expect(rows[0]!.action).toBe('CREATE');
    // No before state, because nothing existed — distinguishable from "not captured".
    expect(rows[0]!.beforeValue).toBeNull();
    expect(rows[0]!.afterValue).toMatchObject({
      code: 'p3s3_probe_created',
      numericValue: 250,
      status: 'ACTIVE',
    });
  });

  /**
   * Two cases, and the first is the one that matters: a code a MIGRATION seeded.
   * Re-adding an existing code would give one code two meanings across time, and a
   * reader of an old entry could not tell which era it belongs to.
   *
   * `bottle_500` is real seeded configuration (P3.S1). The first version of this
   * suite used it as a throwaway test code and hit this conflict for real, which is
   * the check working — hence the `p3s3_` prefix on everything this suite creates.
   */
  it('refuses a code the deployment already defines, as a conflict', async () => {
    // The body, not merely that something threw. A bare `rejects.toThrow()` passed
    // equally for a clean 409 and for the opaque 500 a raw Prisma `P2002` produces —
    // which is exactly the regression worth catching here.
    await expect(
      service.addMember(
        SET_KEY,
        { code: 'bottle_500', sortOrder: 20, numericValue: 500, numericUnit: 'mL' },
        ADMIN_SUBJECT,
        undefined,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'VALUE_SET_MEMBER_CODE_IN_USE' } },
    });
  });

  it('refuses a code this suite just created, as a conflict', async () => {
    await expect(
      service.addMember(
        SET_KEY,
        { code: 'p3s3_probe_created', sortOrder: 20, numericValue: 250, numericUnit: 'mL' },
        ADMIN_SUBJECT,
        undefined,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { error: { code: 'VALUE_SET_MEMBER_CODE_IN_USE' } },
    });
  });

  it('refuses a set that does not exist, and creates nothing', async () => {
    await expect(
      service.addMember(
        'a_set_nobody_defined',
        { code: 'x', sortOrder: 0, numericValue: null, numericUnit: null },
        ADMIN_SUBJECT,
        undefined,
      ),
    ).rejects.toMatchObject({
      status: 404,
      response: { error: { code: 'VALUE_SET_NOT_FOUND' } },
    });

    // The test name said "rather than creating one" and nothing checked it.
    expect(await prisma.valueSet.findUnique({ where: { key: 'a_set_nobody_defined' } })).toBeNull();
  });

  /**
   * The rule the whole surface is shaped around: a clinical record references a
   * member by code, so a delete makes stored entries unreadable — silently, and
   * retrospectively.
   */
  it('retires a member without deleting the row', async () => {
    const created = await service.addMember(
      SET_KEY,
      { code: 'p3s3_probe_retired', sortOrder: 30, numericValue: 1000, numericUnit: 'mL' },
      ADMIN_SUBJECT,
      undefined,
    );

    const retired = await service.retireMember(
      SET_KEY,
      'p3s3_probe_retired',
      ADMIN_SUBJECT,
      undefined,
    );

    expect(retired.member.status).toBe('RETIRED');
    // Still there, and still resolving to the meaning an old entry relied on.
    const row = await prisma.valueSetMember.findUnique({ where: { id: created.memberId } });
    expect(row).not.toBeNull();
    expect(row!.numericValue?.toNumber()).toBe(1000);
    expect(row!.status).toBe('RETIRED');
    /**
     * Asserted on the ROW, not on the returned snapshot. The snapshot reports
     * `retiredAt` from a local variable the service constructs, so it reads non-null
     * even when the column is never written — my first version of this assertion was
     * vacuous for exactly that reason, and a mutation removing `retiredAt` from the
     * `data` object left the suite green.
     *
     * This surface is the column's only writer. Without it, every retired member
     * reads `retired_at IS NULL` forever and "retired before release X" silently
     * answers nothing.
     */
    expect(row!.retiredAt).not.toBeNull();
    expect(retired.member.retiredAt).toBe(row!.retiredAt?.toISOString());
  });

  it('records the retirement as an UPDATE with before and after', async () => {
    const created = await service.addMember(
      SET_KEY,
      { code: 'p3s3_probe_audited', sortOrder: 40, numericValue: 500, numericUnit: 'mL' },
      ADMIN_SUBJECT,
      undefined,
    );
    await service.retireMember(SET_KEY, 'p3s3_probe_audited', ADMIN_SUBJECT, undefined);

    const rows = await auditRowsFor(created.memberId);
    expect(rows.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
    // Asserted on the RETIRE row specifically. Only the create row's actor was
    // checked, so an actor dropped on this path would have passed.
    expect(rows[1]!.actorType).toBe('ADMIN');
    expect(rows[1]!.actorId).toBe(ADMIN_SUBJECT);
    // `UPDATE`, never `DELETE`: the row still exists, and telling a future reader
    // otherwise would contradict the guarantee retirement provides.
    expect(rows[1]!.beforeValue).toMatchObject({ status: 'ACTIVE', retiredAt: null });
    expect(rows[1]!.afterValue).toMatchObject({ status: 'RETIRED' });
    // The transition is visible in the row, not only the end state.
    expect((rows[1]!.afterValue as { retiredAt: string | null }).retiredAt).not.toBeNull();
  });

  /**
   * A retry must not add a second row. `audit_events` has no `DELETE` grant anywhere
   * (ADR-0011), so a duplicate is uncorrectable.
   */
  it('is idempotent, writing no second audit row for an already-retired member', async () => {
    const created = await service.addMember(
      SET_KEY,
      { code: 'p3s3_probe_idempotent', sortOrder: 50, numericValue: 750, numericUnit: 'mL' },
      ADMIN_SUBJECT,
      undefined,
    );
    await service.retireMember(SET_KEY, 'p3s3_probe_idempotent', ADMIN_SUBJECT, undefined);
    const again = await service.retireMember(
      SET_KEY,
      'p3s3_probe_idempotent',
      ADMIN_SUBJECT,
      undefined,
    );

    expect(again.member.status).toBe('RETIRED');
    expect(again.auditEventId).toBeUndefined();
    expect(await auditRowsFor(created.memberId)).toHaveLength(2);
  });

  /**
   * The failure this ordering prevents is a configuration change with no audit row,
   * which is undetectable afterwards because the changed row looks legitimate. Proven
   * by making the audit write fail: the member must not exist either.
   */
  it('leaves no member behind when the audit write fails', async () => {
    const audit = {
      record: () => {
        throw new Error('audit unavailable');
      },
    };
    const brittle = new AdminValueSetsService(
      prisma as never,
      audit as never,
      new ThresholdsService(prisma as never, 60_000) as never,
    );

    await expect(
      brittle.addMember(
        SET_KEY,
        { code: 'p3s3_probe_never_committed', sortOrder: 60, numericValue: 100, numericUnit: 'mL' },
        ADMIN_SUBJECT,
        undefined,
      ),
    ).rejects.toThrow();

    const orphan = await prisma.valueSetMember.findFirst({
      where: { code: 'p3s3_probe_never_committed' },
    });
    expect(orphan).toBeNull();
  });

  /**
   * The assertion that actually pins "same transaction", and it exists because the
   * orphan test above does NOT.
   *
   * That test proves a failed audit write leaves no member — true whether the two
   * share a transaction or not, since either way the throw propagates out of the
   * callback and rolls the insert back. Removing the `tx` argument entirely left the
   * whole suite green, so this file's own header was claiming more than it proved.
   *
   * What in-transaction actually buys is the reverse case, which no test can stage
   * from here: the member commits and the audit row does not, because a crash lands
   * between two separate transactions. That leaves a configuration change with no
   * audit row, undetectable afterwards because the changed row looks legitimate. The
   * observable stand-in is that the transaction client reaches `AuditService.record`
   * at all.
   */
  it('passes the transaction client to the audit write, so the two commit together', async () => {
    const received: unknown[] = [];
    const real = new AuditService(prisma as never);
    const spy = {
      record: async (context: unknown, tx?: unknown) => {
        received.push(tx);
        return real.record(context as never, tx as never);
      },
    };
    const spied = new AdminValueSetsService(
      prisma as never,
      spy as never,
      new ThresholdsService(prisma as never, 60_000) as never,
    );

    await spied.addMember(
      SET_KEY,
      { code: 'p3s3_probe_tx', sortOrder: 70, numericValue: 300, numericUnit: 'mL' },
      ADMIN_SUBJECT,
      undefined,
    );

    expect(received).toHaveLength(1);
    // `toBeDefined()` alone was still vacuous: passing `this.prisma` instead of `tx`
    // kept it green while the guarantee was gone — the same hole, one level up from
    // the one it was written to close.
    //
    // Identity is the discriminator, and it is the right one: the service is
    // constructed with exactly this client, so `this.prisma` would be referentially
    // equal to it while the transaction client never is. (A reviewer suggested also
    // asserting the client has no `$transaction`; it does have one in this Prisma
    // version, so that check fails against correct code.)
    expect(received[0]).not.toBe(prisma);
  });

  /**
   * Both sides of a two-sided contract, in one test, with a code of its own.
   *
   * It previously asserted only that SOME retired member appeared, which passed only
   * because earlier tests in the file had retired something — a dependency on
   * execution order — and it never consulted the patient surface its name invokes.
   */
  it('reports a retired member that the patient surface hides', async () => {
    await service.addMember(
      SET_KEY,
      { code: 'p3s3_probe_listing', sortOrder: 80, numericValue: 400, numericUnit: 'mL' },
      ADMIN_SUBJECT,
      undefined,
    );
    await service.retireMember(SET_KEY, 'p3s3_probe_listing', ADMIN_SUBJECT, undefined);

    const listed = await service.listValueSets();
    const set = listed.valueSets.find((candidate) => candidate.key === SET_KEY);
    expect(set?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'p3s3_probe_listing', status: 'RETIRED' }),
      ]),
    );

    // Absent from what a patient client renders. Retirement is expressed by ABSENCE
    // there, which is why the device cache does a delete-then-insert per set.
    const active = await thresholds.getActiveValueSetMembers(SET_KEY);
    expect(active.map((member) => member.code)).not.toContain('p3s3_probe_listing');
  });

  /**
   * The entire stated reason `AdminConfigModule` imports `ThresholdsModule`, and
   * nothing verified it: removing both `invalidate()` calls left the whole suite green.
   */
  describe('a write is felt by the patient-facing read path', () => {
    it('shows an added member without waiting out the cache TTL', async () => {
      await thresholds.getActiveValueSetMembers(SET_KEY); // populate
      await service.addMember(
        SET_KEY,
        { code: 'p3s3_probe_cache_add', sortOrder: 90, numericValue: 150, numericUnit: 'mL' },
        ADMIN_SUBJECT,
        undefined,
      );

      const active = await thresholds.getActiveValueSetMembers(SET_KEY);
      expect(active.map((member) => member.code)).toContain('p3s3_probe_cache_add');
    });

    it('stops offering a retired member without waiting out the cache TTL', async () => {
      await service.addMember(
        SET_KEY,
        { code: 'p3s3_probe_cache_retire', sortOrder: 91, numericValue: 160, numericUnit: 'mL' },
        ADMIN_SUBJECT,
        undefined,
      );
      await thresholds.getActiveValueSetMembers(SET_KEY); // populate, with it present
      await service.retireMember(SET_KEY, 'p3s3_probe_cache_retire', ADMIN_SUBJECT, undefined);

      const active = await thresholds.getActiveValueSetMembers(SET_KEY);
      expect(active.map((member) => member.code)).not.toContain('p3s3_probe_cache_retire');
    });
  });

  /**
   * "Retired, never deleted" stated in this surface's own terms. It is proven
   * generically in `prisma.integration.spec.ts`, but a migration re-granting `DELETE`
   * would be caught there and not here, and this is the file a reviewer of this
   * surface reads.
   */
  it('cannot delete a member, because the runtime role holds no DELETE grant', async () => {
    const created = await service.addMember(
      SET_KEY,
      { code: 'p3s3_probe_undeletable', sortOrder: 92, numericValue: 170, numericUnit: 'mL' },
      ADMIN_SUBJECT,
      undefined,
    );

    await expect(prisma.valueSetMember.delete({ where: { id: created.memberId } })).rejects.toThrow(
      /permission denied/i,
    );
  });

  /** The same grant, for the audit table, on an ADMIN-actor row specifically (ADR-0011). */
  it('cannot amend the audit row it just wrote', async () => {
    const created = await service.addMember(
      SET_KEY,
      { code: 'p3s3_probe_audit_immutable', sortOrder: 93, numericValue: 180, numericUnit: 'mL' },
      ADMIN_SUBJECT,
      undefined,
    );

    await expect(
      prisma.auditEvent.update({
        where: { id: created.auditEventId },
        data: { actorId: 'someone-else' },
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('records the correlation id when the request carries one', async () => {
    // Without it an admin configuration change cannot be tied back to a request in the
    // logs, on the one surface where "who did this, in which request" is the point.
    const created = await service.addMember(
      SET_KEY,
      { code: 'p3s3_probe_correlated', sortOrder: 94, numericValue: 190, numericUnit: 'mL' },
      ADMIN_SUBJECT,
      'request-abc',
    );

    const rows = await auditRowsFor(created.memberId);
    expect(rows[0]!.correlationId).toBe('request-abc');
  });

  /**
   * The "deliberately not filtered by `PUBLISHED_VALUE_SET_KEYS`" claim in
   * `listValueSets`'s own comment, which nothing checked.
   *
   * It needed a set to exist that no client publishes, and none does today — the table
   * holds exactly the four published sets, so the claim was untestable against real
   * data and my first attempt asserted a set (`appliance_type`) that does not exist.
   * `UNPUBLISHED_SET_KEY` is inserted by the owner role in `beforeAll` to stand in for
   * the case the comment describes.
   */
  it('lists a set no client publishes, so configuration is inspectable before release', async () => {
    const listed = await service.listValueSets();
    expect(listed.valueSets.map((set) => set.key)).toContain(UNPUBLISHED_SET_KEY);
  });
});
