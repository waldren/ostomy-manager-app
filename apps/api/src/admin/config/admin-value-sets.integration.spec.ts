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
 * database guarantee: that the audit row lands in the SAME transaction as the
 * configuration change, that retirement is a status and not a delete, and that the
 * runtime role can insert an audit row and cannot amend one (ADR-0011). Mocking
 * `$transaction` would assert the shape of my own mock.
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

describe.skipIf(!dockerAvailable)('AdminValueSetsService — real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let service: AdminValueSetsService;

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
      await owner.query(
        `INSERT INTO value_sets (id, key, description, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, 'Quick-select container sizes', now(), now())
         ON CONFLICT (key) DO NOTHING`,
        [SET_KEY],
      );
    } finally {
      await owner.end();
    }

    const runtimeDatabaseUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@${container.getHost()}:${String(container.getPort())}/ostomy_admin_config_test`;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeDatabaseUrl }) });

    const thresholds = new ThresholdsService(prisma as never, 60_000);
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
  it('refuses a code the deployment already defines', async () => {
    await expect(
      service.addMember(
        SET_KEY,
        { code: 'bottle_500', sortOrder: 20, numericValue: 500, numericUnit: 'mL' },
        ADMIN_SUBJECT,
      ),
    ).rejects.toThrow();
  });

  it('refuses a code this suite just created', async () => {
    await expect(
      service.addMember(
        SET_KEY,
        { code: 'p3s3_probe_created', sortOrder: 20, numericValue: 250, numericUnit: 'mL' },
        ADMIN_SUBJECT,
      ),
    ).rejects.toThrow();
  });

  it('refuses a set that does not exist, rather than creating one', async () => {
    await expect(
      service.addMember(
        'a_set_nobody_defined',
        { code: 'x', sortOrder: 0, numericValue: null, numericUnit: null },
        ADMIN_SUBJECT,
      ),
    ).rejects.toThrow();
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
    );

    const retired = await service.retireMember(SET_KEY, 'p3s3_probe_retired', ADMIN_SUBJECT);

    expect(retired.member.status).toBe('RETIRED');
    // Still there, and still resolving to the meaning an old entry relied on.
    const row = await prisma.valueSetMember.findUnique({ where: { id: created.memberId } });
    expect(row).not.toBeNull();
    expect(row!.numericValue?.toNumber()).toBe(1000);
  });

  it('records the retirement as an UPDATE with before and after', async () => {
    const created = await service.addMember(
      SET_KEY,
      { code: 'p3s3_probe_audited', sortOrder: 40, numericValue: 500, numericUnit: 'mL' },
      ADMIN_SUBJECT,
    );
    await service.retireMember(SET_KEY, 'p3s3_probe_audited', ADMIN_SUBJECT);

    const rows = await auditRowsFor(created.memberId);
    expect(rows.map((row) => row.action)).toEqual(['CREATE', 'UPDATE']);
    // `UPDATE`, never `DELETE`: the row still exists, and telling a future reader
    // otherwise would contradict the guarantee retirement provides.
    expect(rows[1]!.beforeValue).toMatchObject({ status: 'ACTIVE' });
    expect(rows[1]!.afterValue).toMatchObject({ status: 'RETIRED' });
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
    );
    await service.retireMember(SET_KEY, 'p3s3_probe_idempotent', ADMIN_SUBJECT);
    const again = await service.retireMember(SET_KEY, 'p3s3_probe_idempotent', ADMIN_SUBJECT);

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
    );

    expect(received).toHaveLength(1);
    // `undefined` here would mean the audit row is a second transaction.
    expect(received[0]).toBeDefined();
  });

  it('reports retired members, which the patient surface hides', async () => {
    const listed = await service.listValueSets();
    const set = listed.valueSets.find((candidate) => candidate.key === SET_KEY);

    expect(set?.members.some((member) => member.status === 'RETIRED')).toBe(true);
  });
});
