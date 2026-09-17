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

import {
  isBlocked,
  validateVolumetricEntry,
  type VolumetricValidationThresholds,
} from '@ostomy/core/validation';

import { generateStableIleostomy } from './scenarios/stableIleostomy.js';
import type { ScenarioOptions, SeedDataset } from './types.js';

/**
 * `@ostomy/seed` — deterministic synthetic development data (ADR-0009).
 *
 * ## The one rule this package exists to enforce
 *
 * **Every generated row is validated against `@ostomy/core` before anything
 * writes it.** ADR-0009: "seed data that is not valid by construction
 * produces a development database the application's own validation rules
 * would reject, and every developer then debugs against data that could not
 * exist."
 *
 * That validation is not a convenience the writer may skip.
 * `assertScenarioIsValid` throws, and the writer in `apps/api/src/seed/`
 * calls it before its first insert — a scenario that cannot be validated is
 * a scenario that does not get written.
 *
 * ## Thresholds are read, never assumed
 *
 * `assertScenarioIsValid` takes thresholds as an argument and the writer
 * passes what the database actually holds. A hardcoded 2,000 here would make
 * this package's own check disagree with the running application the moment
 * an admin tuned the value — and the check would keep passing, which is the
 * worst of both.
 *
 * ## No PHI, ever, by construction
 *
 * ADR-0009's compliance review governs this package. Nothing here is derived
 * from, sampled from, or shaped to match a real record; there are no names or
 * dates of birth in the types at all; and this package has no database
 * connection and no production code path. It is a `devDependency` of the API
 * and is excluded from the runtime image — see `infra/docker/api.Dockerfile`.
 */

export { createRng, deterministicUuid, type Rng } from './rng.js';
export {
  STOMA_OUTPUT_LOINC_CODE,
  type ScenarioOptions,
  type SeedDataset,
  type SeedObservation,
  type SeedOstomyType,
  type SeedPatient,
  type SeedProfile,
} from './types.js';

/** The scenarios this release can generate. `docs/deployment-development.md` names six; the rest land at P3.S5 and P5. */
export const SCENARIO_NAMES = ['stable-ileostomy'] as const;
export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export function isScenarioName(value: string): value is ScenarioName {
  return (SCENARIO_NAMES as readonly string[]).includes(value);
}

export interface GenerateOptions extends ScenarioOptions {
  /**
   * `ESTIMATION_METHOD_CODE`'s value, or `null` to generate measured entries
   * only. Passed in rather than imported so the seeder cannot be the thing
   * that keeps a stale copy of a terminology code alive — the caller reads
   * it from `@ostomy/core/validation` and hands it over (ADR-0018).
   */
  readonly estimationMethodCode: string | null;
}

export function generateScenario(name: ScenarioName, options: GenerateOptions): SeedDataset {
  switch (name) {
    case 'stable-ileostomy':
      return generateStableIleostomy(options);
    default: {
      // Exhaustiveness: adding a name to SCENARIO_NAMES without a generator
      // is a compile error here rather than a runtime surprise at 2am on the
      // dev host.
      const unreachable: never = name;
      throw new Error(`No generator for scenario ${String(unreachable)}.`);
    }
  }
}

export interface ScenarioValidationProblem {
  readonly observationId: string;
  readonly ruleCode: string;
}

/**
 * Re-runs the application's own Tier 1 rules over a generated dataset.
 *
 * Deliberately the same `validateVolumetricEntry` the API and the phone call,
 * not a reimplementation: sharing the module is what makes a rule change
 * automatically constrain the seed data too (ADR-0009). A local copy of the
 * rules would drift and the seeder would keep claiming validity it no longer
 * had.
 */
export function findTier1Problems(
  dataset: SeedDataset,
  thresholds: VolumetricValidationThresholds,
  now: Date,
): ScenarioValidationProblem[] {
  const problems: ScenarioValidationProblem[] = [];

  for (const observation of dataset.observations) {
    const result = validateVolumetricEntry(
      {
        field: 'valueQuantity.value',
        rawValueMl: Number(observation.valueQuantityValue),
        method: observation.method === null ? 'measured' : 'estimated',
        effectiveDateTime: observation.effectiveDatetime,
        surgeryDate: dataset.profile.surgeryDate,
        now,
      },
      thresholds,
    );

    if (isBlocked(result) && result.tier1.outcome === 'blocked') {
      for (const error of result.tier1.errors) {
        problems.push({ observationId: observation.id, ruleCode: error.ruleCode });
      }
    }
  }

  return problems;
}

/**
 * Tier 2 warnings a generated dataset trips.
 *
 * Reported separately from Tier 1 because the two mean opposite things here.
 * A Tier 1 failure is always a generator bug. A Tier 2 warning is a bug in
 * every scenario **except** `validation-edge-cases` (P3.S5), where producing
 * them is the entire point — so the caller decides, and this function only
 * counts.
 */
export function findTier2Warnings(
  dataset: SeedDataset,
  thresholds: VolumetricValidationThresholds,
  now: Date,
): ScenarioValidationProblem[] {
  const warnings: ScenarioValidationProblem[] = [];

  for (const observation of dataset.observations) {
    const result = validateVolumetricEntry(
      {
        field: 'valueQuantity.value',
        rawValueMl: Number(observation.valueQuantityValue),
        method: observation.method === null ? 'measured' : 'estimated',
        effectiveDateTime: observation.effectiveDatetime,
        surgeryDate: dataset.profile.surgeryDate,
        now,
      },
      thresholds,
    );

    if (result.tier2.outcome === 'warn') {
      for (const warning of result.tier2.warnings) {
        warnings.push({ observationId: observation.id, ruleCode: warning.ruleCode });
      }
    }
  }

  return warnings;
}

/**
 * Throws unless every row in the dataset would be accepted by the
 * application. Called by the writer before its first insert.
 *
 * The message names rule codes and observation ids, never values — the same
 * discipline `ValidationError` enforces structurally (`docs/security-hipaa.md`:
 * "field identifiers and rule codes, never the offending value"). Seed data
 * is synthetic, so a value here would leak nothing; the habit is what
 * matters, because this message format is what someone copies the next time
 * they write an error that handles real data.
 */
export function assertScenarioIsValid(
  dataset: SeedDataset,
  thresholds: VolumetricValidationThresholds,
  now: Date,
): void {
  const problems = findTier1Problems(dataset, thresholds, now);
  if (problems.length > 0) {
    const summary = problems
      .slice(0, 5)
      .map((problem) => `${problem.observationId}: ${problem.ruleCode}`)
      .join('; ');
    throw new Error(
      `Scenario "${dataset.scenario}" generated ${String(problems.length)} row(s) the application's own Tier 1 rules would reject, so it was not written. First few: ${summary}`,
    );
  }
}
