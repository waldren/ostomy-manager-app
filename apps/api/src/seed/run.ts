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
 * Writes a generated scenario into the development database (ADR-0009, P2.S4).
 *
 *   node dist/seed/run.js --scenario stable-ileostomy --subject <oidc-sub>
 *
 * ## Why the writer lives here and the generator lives in `packages/seed`
 *
 * ADR-0009 decided the seeder writes through **Prisma** rather than through
 * the HTTP API, and validates every row against `packages/core` first. Both
 * hold. The split is where the seam has to fall: the Prisma client is
 * generated into `apps/api/src/generated/prisma` by this app's own schema, so
 * a package importing it would depend on the app rather than the reverse.
 *
 * The half that is worth testing — deterministic generation, validity by
 * construction, relative-to-now timestamps — is in `@ostomy/seed` with no
 * database anywhere near it. This file is deliberately small enough to read
 * in one sitting.
 *
 * ## Two independent things stop this reaching production
 *
 * ADR-0009: "`packages/seed` must have no code path to a production
 * database and must not appear in a production build."
 *
 * 1. **`@ostomy/seed` is a devDependency of this app.** The runtime image is
 *    built with `pnpm deploy --prod`, which omits it; the `migrate` image
 *    uses a full install, which includes it. So in a production runtime image
 *    this file's own import fails to resolve and the script cannot run at all.
 *    This is the structural control, and it is the one that actually holds.
 * 2. **The `ALLOW_SYNTHETIC_SEED` opt-in below.** Weaker, and honestly
 *    labelled: anyone who can run the script can set the variable, so it is
 *    not a security boundary. It is a guard against the realistic accident —
 *    a tired operator running the wrong command against the wrong DSN — and
 *    it fails with a sentence rather than by quietly writing 450 rows.
 *
 * `NODE_ENV` is deliberately NOT the guard, which was the first thing tried.
 * The `migrate` stage sets `NODE_ENV=production` as a deployed-artifact
 * convention (`infra/docker/api.Dockerfile`), and that stage is exactly where
 * this script is supposed to run — so keying on it refuses the seeder in its
 * own home while saying nothing true about which database it is pointed at.
 *
 * Being honest about a deviation: the *compiled* `dist/seed/run.js` is still
 * present in the runtime image, because `apps/api` builds one `dist` and
 * `files: ["dist"]` packs all of it. A literal reading of "must not appear in
 * a production build" would exclude it. It is inert there — its dependency is
 * absent and the guard refuses — and splitting the build into two tsconfigs
 * to remove a file that cannot execute costs more than it buys. Recorded so
 * the next reader does not have to work out whether it was noticed.
 *
 * ## Seeded rows carry no audit events, on purpose
 *
 * ADR-0009 names this as the cost of bypassing the API: "any test asserting
 * audit coverage must create its data through the API rather than the
 * seeder — a distinction that is easy to forget and will produce a confusing
 * failure the first time someone forgets it." It is repeated here because
 * this file is where someone would otherwise be tempted to add one.
 */
import {
  assertScenarioIsValid,
  generateScenario,
  isScenarioName,
  type ScenarioName,
  type SeedDataset,
} from '@ostomy/seed';
import { ESTIMATION_METHOD_CODE } from '@ostomy/core/validation';
import type { VolumetricValidationThresholds } from '@ostomy/core/validation';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';

interface SeedArgs {
  readonly scenario: ScenarioName;
  readonly oidcSubject: string;
  readonly seed: number | undefined;
}

function parseArgs(argv: readonly string[]): SeedArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg !== undefined && arg.startsWith('--')) {
      values.set(arg.slice(2), argv[index + 1] ?? '');
    }
  }

  const scenario = values.get('scenario') ?? 'stable-ileostomy';
  if (!isScenarioName(scenario)) {
    throw new Error(
      `Unknown scenario "${scenario}". This release generates: stable-ileostomy. The remaining scenarios in docs/deployment-development.md land at P3.S5 and P5.`,
    );
  }

  const oidcSubject = values.get('subject');
  if (oidcSubject === undefined || oidcSubject === '') {
    // No default, deliberately. A dataset nobody can sign in as looks seeded
    // and behaves like an empty database — which is the failure the Gate B
    // rehearsal hit from the other direction (PATIENT_NOT_PROVISIONED).
    throw new Error(
      'A --subject is required: the OIDC `sub` claim the seeded patient answers to. Without it, JwtAuthGuard finds no patient row for any token and every request is PATIENT_NOT_PROVISIONED.',
    );
  }

  const rawSeed = values.get('seed');
  const seed = rawSeed === undefined || rawSeed === '' ? undefined : Number(rawSeed);
  if (seed !== undefined && !Number.isFinite(seed)) {
    throw new Error(`--seed must be a number; received "${rawSeed ?? ''}".`);
  }

  return { scenario, oidcSubject, seed };
}

/**
 * Reads the thresholds the application itself is configured with.
 *
 * Read from the database rather than assumed, so the validity check below is
 * against the values the running API will actually enforce. A hardcoded 2,000
 * here would keep passing after an admin tuned the threshold, and the dev
 * database would quietly fill with rows that warn.
 */
async function readThresholds(prisma: PrismaClient): Promise<VolumetricValidationThresholds> {
  const rows = await prisma.validationThreshold.findMany({
    where: {
      thresholdKey: {
        in: ['stoma_output_single_entry_warning_ml', 'sync_clock_skew_allowance_seconds'],
      },
    },
  });

  const byKey = new Map(rows.map((row) => [row.thresholdKey, Number(row.value)]));
  const softWarningMaxMl = byKey.get('stoma_output_single_entry_warning_ml');
  const clockSkewSeconds = byKey.get('sync_clock_skew_allowance_seconds');

  if (softWarningMaxMl === undefined || clockSkewSeconds === undefined) {
    throw new Error(
      'validation_thresholds is missing a required row. Run migrations first — 20260917000000_seed_default_validation_thresholds establishes the defaults.',
    );
  }

  return { softWarningMaxMl, maxClockSkewMs: clockSkewSeconds * 1000 };
}

/**
 * Replaces this subject's existing data, so re-seeding is idempotent.
 *
 * Scoped to the one patient rather than truncating: `dev-reset` already wipes
 * the whole volume, and a seeder that silently emptied every table would be a
 * loaded gun pointed at a database someone ran it against by mistake.
 */
async function clearExistingData(prisma: PrismaClient, oidcSubject: string): Promise<void> {
  const existing = await prisma.patient.findUnique({ where: { oidcSubject } });
  if (existing === null) return;

  await prisma.observation.deleteMany({ where: { patientId: existing.id } });
  await prisma.profile.deleteMany({ where: { patientId: existing.id } });
  await prisma.patient.delete({ where: { id: existing.id } });
}

async function write(prisma: PrismaClient, dataset: SeedDataset): Promise<void> {
  await prisma.patient.create({
    data: { id: dataset.patient.id, oidcSubject: dataset.patient.oidcSubject },
  });

  await prisma.profile.create({
    data: {
      id: dataset.profile.id,
      patientId: dataset.profile.patientId,
      ostomyType: dataset.profile.ostomyType,
      surgeryDate: dataset.profile.surgeryDate,
      measurementSystem: dataset.profile.measurementSystem === 'metric' ? 'METRIC' : 'IMPERIAL',
      clientUpdatedAt: dataset.profile.clientUpdatedAt,
    },
  });

  // `createMany` rather than a loop: ~450 rows, and each insert takes a
  // `sync_sequence` value from the same Postgres sequence the delta cursor
  // reads. One statement keeps that assignment contiguous and the seeding
  // fast enough that `dev-reset` stays a thing people are willing to run.
  await prisma.observation.createMany({
    data: dataset.observations.map((observation) => ({
      id: observation.id,
      patientId: observation.patientId,
      code: observation.code,
      valueQuantityValue: observation.valueQuantityValue,
      valueQuantityUnit: observation.valueQuantityUnit,
      effectiveDatetime: observation.effectiveDatetime,
      method: observation.method,
      enteredMeasurementSystem:
        observation.enteredMeasurementSystem === 'metric' ? 'METRIC' : 'IMPERIAL',
      enteredTimezone: observation.enteredTimezone,
      localDate: new Date(`${observation.localDate}T00:00:00.000Z`),
      clientUpdatedAt: observation.clientUpdatedAt,
    })),
  });
}

async function main(): Promise<void> {
  if (process.env.ALLOW_SYNTHETIC_SEED !== 'true') {
    throw new Error(
      'Refusing to seed: set ALLOW_SYNTHETIC_SEED=true to confirm this database should receive synthetic development data. scripts/dev-reset.sh sets it. This generator has no place in a production database (ADR-0009, CLAUDE.md "No real PHI outside production").',
    );
  }

  const args = parseArgs(process.argv.slice(2));

  // `MIGRATION_DATABASE_URL` first: this script runs from the `migrate`
  // container, which carries the OWNER DSN and not the runtime one. The two
  // are deliberately different variable names (see infra/docker-compose.yml)
  // so a stray root `.env` cannot silently run the API as the schema owner.
  //
  // Seeding as the owner is consistent with ADR-0011 rather than an exception
  // to it: that decision governs REQUEST HANDLING — "the API never runs as the
  // database schema owner" — and this is an administrative tool that runs
  // beside `prisma migrate deploy`, not a request path. It also needs DELETE
  // on `observations` to stay idempotent, which the runtime role is not
  // guaranteed to have.
  //
  // `DATABASE_URL` is accepted as a fallback for running the seeder outside
  // the container (`pnpm --filter @ostomy/api seed`) against a local database.
  const connectionString = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (connectionString === undefined || connectionString === '') {
    throw new Error(
      'Neither MIGRATION_DATABASE_URL nor DATABASE_URL is set, so there is no database to seed.',
    );
  }

  // A standalone client, not `PrismaService`: this is a script, not a Nest
  // process, and booting the module graph would drag in the audit
  // interceptor and the guards for a job that makes no HTTP request.
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

  try {
    const thresholds = await readThresholds(prisma);
    const now = new Date();

    const dataset = generateScenario(args.scenario, {
      oidcSubject: args.oidcSubject,
      now,
      estimationMethodCode: ESTIMATION_METHOD_CODE.resolved ? ESTIMATION_METHOD_CODE.code : null,
      ...(args.seed === undefined ? {} : { seed: args.seed }),
    });

    // BEFORE the first insert. ADR-0009's whole point: a scenario that would
    // not survive the application's own rules does not get written.
    assertScenarioIsValid(dataset, thresholds, now);

    await clearExistingData(prisma, args.oidcSubject);
    await write(prisma, dataset);

    // The only output is what was written and for whom — a seeder's log is
    // read by a human deciding whether the walkthrough can start.
    // eslint-disable-next-line no-console
    console.log(
      `Seeded "${dataset.scenario}": 1 patient (${dataset.patient.oidcSubject}), 1 profile, ${String(dataset.observations.length)} observations.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
