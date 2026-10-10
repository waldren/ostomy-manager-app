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
 * Range resolution against real PostgreSQL (P4.S2 slice 2, #130).
 *
 * `range-selection.spec.ts` covers the rules as pure functions. This covers the
 * three things only a database can answer: that the seeded defaults actually
 * produce a suggestion for a patient at a given post-operative day, that the
 * partial unique index refuses a second ACTIVE row of one provenance, and that a
 * tombstone frees that slot. Each of those involves the migration, the schema
 * and the service agreeing, which a mocked Prisma cannot demonstrate.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaClient } from '../generated/prisma/client';

import { RangesService } from './ranges.service';

const API_ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_ROLE = 'ostomy_runtime';
const RUNTIME_PASSWORD = 'ranges-integration-test-only-password';

/** Fixed, so "days post-op" is stated by each test rather than inherited from the clock. */
const NOW = new Date('2026-10-09T12:00:00.000Z');

describe('RangesService — real PostgreSQL', () => {
  let container: StartedPostgreSqlContainer;
  let prisma: PrismaClient;
  let service: RangesService;
  let subject: string;
  let patientId: string;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('postgres:17-alpine')
      .withDatabase('ostomy_ranges_test')
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

    const runtimeDatabaseUrl = `postgresql://${RUNTIME_ROLE}:${RUNTIME_PASSWORD}@${container.getHost()}:${String(container.getPort())}/ostomy_ranges_test`;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: runtimeDatabaseUrl }) });
    service = new RangesService(prisma as never);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await container?.stop();
  });

  beforeEach(async () => {
    subject = `patient-${randomUUID()}`;
    patientId = randomUUID();
  });

  /** Days before `NOW`, as the `@db.Date` column takes it. */
  function surgeryDaysAgo(days: number): Date {
    return new Date(NOW.getTime() - days * 86_400_000);
  }

  async function seedPatient(
    ostomyType: 'ILEOSTOMY' | 'COLOSTOMY',
    daysPostOp: number,
  ): Promise<void> {
    await prisma.patient.create({ data: { id: patientId, oidcSubject: subject } });
    await prisma.profile.create({
      data: {
        id: randomUUID(),
        patientId,
        ostomyType,
        surgeryDate: surgeryDaysAgo(daysPostOp),
        measurementSystem: 'METRIC',
        clientUpdatedAt: NOW,
      },
    });
  }

  async function addRange(input: {
    rangeType?: string;
    provenance: 'PHYSICIAN_SET' | 'PATIENT_SET' | 'PATIENT_CONFIRMED_SUGGESTION';
    status?: 'PROPOSED' | 'ACTIVE' | 'SUPERSEDED' | 'DISMISSED';
    lowValue?: number;
    highValue?: number;
    deletedAt?: Date;
  }): Promise<string> {
    const id = randomUUID();
    await prisma.effectiveRange.create({
      data: {
        id,
        patientId,
        rangeType: input.rangeType ?? 'daily_output_ml',
        lowValue: input.lowValue ?? 400,
        highValue: input.highValue ?? 900,
        unit: 'mL',
        provenance: input.provenance,
        status: input.status ?? 'ACTIVE',
        clientUpdatedAt: NOW,
        ...(input.deletedAt === undefined ? {} : { deletedAt: input.deletedAt }),
      },
    });
    return id;
  }

  // Generic, so the element type survives the lookup. Typed as
  // `readonly { rangeType: string }[]` it narrowed every result to that one
  // property — and because vitest transpiles without typechecking, the suite
  // was green on a file that did not compile.
  const forType = <T extends { rangeType: string }>(ranges: readonly T[], rangeType: string) =>
    ranges.find((range) => range.rangeType === rangeType);

  describe('suggestions from the seeded clinical defaults', () => {
    /**
     * AC 1's data half: the value and the basis a surface needs to say "typical
     * for an ileostomy about a month after surgery". The copy itself is slice 4;
     * what this asserts is that the right window was chosen.
     */
    it('suggests the early window for a patient ten days post-op', async () => {
      await seedPatient('ILEOSTOMY', 10);

      const output = forType(await service.resolveForPatient(subject, NOW), 'daily_output_ml');

      expect(output?.lowValue).toBe(600);
      expect(output?.highValue).toBe(1500);
      expect(output?.basis).toEqual({
        ostomyType: 'ILEOSTOMY',
        daysPostOp: 10,
        minDaysPostOp: 0,
        maxDaysPostOp: 30,
      });
    });

    it('moves to the next window once the patient crosses it', async () => {
      await seedPatient('ILEOSTOMY', 45);

      const output = forType(await service.resolveForPatient(subject, NOW), 'daily_output_ml');

      expect(output?.lowValue).toBe(500);
      expect(output?.highValue).toBe(1200);
    });

    it('keeps suggesting the open-ended window years later', async () => {
      await seedPatient('ILEOSTOMY', 2000);

      const output = forType(await service.resolveForPatient(subject, NOW), 'daily_output_ml');

      expect(output?.highValue).toBe(1000);
      expect(output?.basis?.maxDaysPostOp).toBeNull();
    });

    /** The keying that `colostomy-baseline` exists to demonstrate, at the range level. */
    it('suggests different values for a colostomy at the same post-operative day', async () => {
      await seedPatient('COLOSTOMY', 10);

      const output = forType(await service.resolveForPatient(subject, NOW), 'daily_output_ml');

      expect(output?.lowValue).toBe(300);
      expect(output?.highValue).toBe(800);
    });

    /**
     * AC 2. A default nobody has confirmed is shown as a suggestion and is NOT a
     * threshold — the distinction anomaly flagging (P5.S2) will read.
     */
    it('marks an unconfirmed default as not an active threshold', async () => {
      await seedPatient('ILEOSTOMY', 10);

      const ranges = await service.resolveForPatient(subject, NOW);

      expect(ranges.length).toBeGreaterThan(0);
      for (const range of ranges) {
        expect(range.provenance).toBe('CLINICAL_DEFAULT');
        expect(range.isActiveThreshold).toBe(false);
      }
    });

    /**
     * `SAFETY_RANGE_TYPES`' first consumer, exercised against the real seeded
     * rows rather than a fixture. `heart_rate_red_flag_bpm` has default rows for
     * both ostomy types (#94), and a patient must never get a range derived from
     * one: it is a clinical safety bound and not patient-adjustable.
     */
    it('never derives a patient range from the heart-rate safety bound', async () => {
      await seedPatient('ILEOSTOMY', 10);

      const ranges = await service.resolveForPatient(subject, NOW);

      expect(ranges.map((range) => range.rangeType)).not.toContain('heart_rate_red_flag_bpm');
      expect(ranges.map((range) => range.rangeType).sort()).toEqual([
        'daily_output_ml',
        'net_fluid_balance_ml',
        'urine_output_adequacy_ml',
      ]);
    });

    it('answers nothing for a subject with no profile, rather than inventing defaults', async () => {
      await prisma.patient.create({ data: { id: patientId, oidcSubject: subject } });

      await expect(service.resolveForPatient(subject, NOW)).resolves.toEqual([]);
    });
  });

  describe('precedence over the patient’s own ranges', () => {
    it('prefers a confirmed patient value to the clinical default', async () => {
      await seedPatient('ILEOSTOMY', 10);
      await addRange({
        provenance: 'PATIENT_CONFIRMED_SUGGESTION',
        lowValue: 700,
        highValue: 1400,
      });

      const output = forType(await service.resolveForPatient(subject, NOW), 'daily_output_ml');

      expect(output?.lowValue).toBe(700);
      expect(output?.provenance).toBe('PATIENT_CONFIRMED_SUGGESTION');
      expect(output?.isActiveThreshold).toBe(true);
    });

    /**
     * AC 4, end to end: both rows ACTIVE, the physician's in force, the
     * divergence reported rather than resolved by deleting one of them.
     */
    it('keeps a physician value in force beside a patient one, and flags the divergence', async () => {
      await seedPatient('ILEOSTOMY', 10);
      await addRange({ provenance: 'PHYSICIAN_SET', lowValue: 450, highValue: 950 });
      await addRange({ provenance: 'PATIENT_SET', lowValue: 800, highValue: 1600 });

      const output = forType(await service.resolveForPatient(subject, NOW), 'daily_output_ml');

      expect(output?.provenance).toBe('PHYSICIAN_SET');
      expect(output?.lowValue).toBe(450);
      expect(output?.divergesFromPhysician).toBe(true);
    });

    /**
     * AC 2 again, where it matters most: a proposal is stored so Preferences can
     * list it, and storing it must not make it apply.
     */
    it('ignores a PROPOSED row and falls back to the default', async () => {
      await seedPatient('ILEOSTOMY', 10);
      await addRange({ provenance: 'PATIENT_SET', status: 'PROPOSED', lowValue: 999 });

      const output = forType(await service.resolveForPatient(subject, NOW), 'daily_output_ml');

      expect(output?.lowValue).toBe(600);
      expect(output?.provenance).toBe('CLINICAL_DEFAULT');
      expect(output?.isActiveThreshold).toBe(false);
    });

    /** A tombstoned range is gone for every purpose, including precedence. */
    it('ignores a deleted range', async () => {
      await seedPatient('ILEOSTOMY', 10);
      await addRange({ provenance: 'PATIENT_SET', lowValue: 999, deletedAt: NOW });

      const output = forType(await service.resolveForPatient(subject, NOW), 'daily_output_ml');

      expect(output?.provenance).toBe('CLINICAL_DEFAULT');
    });

    /**
     * A patient range for one type must not leak into another's answer — the
     * resolution is per range type, and getting that wrong would apply an output
     * threshold to urine.
     */
    it('resolves each range type independently', async () => {
      await seedPatient('ILEOSTOMY', 10);
      await addRange({ provenance: 'PATIENT_SET', rangeType: 'daily_output_ml', lowValue: 777 });

      const ranges = await service.resolveForPatient(subject, NOW);

      expect(forType(ranges, 'daily_output_ml')?.lowValue).toBe(777);
      expect(forType(ranges, 'urine_output_adequacy_ml')?.lowValue).toBe(1000);
      expect(forType(ranges, 'urine_output_adequacy_ml')?.provenance).toBe('CLINICAL_DEFAULT');
    });
  });

  describe('the partial unique index this slice adds', () => {
    /**
     * At most one ACTIVE row per (patient, range type, provenance). Two
     * simultaneously active patient-set values for one type is not a state with
     * a meaning — the newer supersedes the older, which is what `status` and the
     * `previousRangeId` self-relation are for.
     */
    it('refuses a second ACTIVE row of the same provenance', async () => {
      await seedPatient('ILEOSTOMY', 10);
      await addRange({ provenance: 'PATIENT_SET' });

      await expect(addRange({ provenance: 'PATIENT_SET' })).rejects.toThrow();
    });

    /**
     * And permits the state AC 4 requires. A unique index over (patient, range
     * type) would have refused this, forcing the patient's edit to destroy the
     * physician's value.
     */
    it('permits one ACTIVE row per provenance for the same range type', async () => {
      await seedPatient('ILEOSTOMY', 10);
      await addRange({ provenance: 'PHYSICIAN_SET' });
      await addRange({ provenance: 'PATIENT_SET' });

      await expect(
        prisma.effectiveRange.count({ where: { patientId, status: 'ACTIVE' } }),
      ).resolves.toBe(2);
    });

    /** History accumulates: superseding a value must not collide with the row it replaced. */
    it('permits any number of SUPERSEDED rows beside the ACTIVE one', async () => {
      await seedPatient('ILEOSTOMY', 10);
      await addRange({ provenance: 'PATIENT_SET', status: 'SUPERSEDED' });
      await addRange({ provenance: 'PATIENT_SET', status: 'SUPERSEDED' });
      await addRange({ provenance: 'PATIENT_SET', status: 'ACTIVE' });

      await expect(prisma.effectiveRange.count({ where: { patientId } })).resolves.toBe(3);
    });

    /**
     * Partial on `deleted_at` for #97's reason: a tombstone must not keep
     * occupying the slot, or a soft delete would break the workflow it exists to
     * serve.
     */
    it('frees the slot when the ACTIVE row is tombstoned', async () => {
      await seedPatient('ILEOSTOMY', 10);
      await addRange({ provenance: 'PATIENT_SET', deletedAt: NOW });

      await expect(addRange({ provenance: 'PATIENT_SET' })).resolves.toBeDefined();
    });
  });
});
