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
  validateVolumelessObservation,
  validateVolumetricEntry,
  type VolumetricValidationResult,
  type VolumetricValidationThresholds,
} from '@ostomy/core/validation';

import { generateColostomyBaseline } from './scenarios/colostomyBaseline.js';
import { generateHighOutputDehydration } from './scenarios/highOutputDehydration.js';
import { generateNewPostOp } from './scenarios/newPostOp.js';
import { generateStableIleostomy } from './scenarios/stableIleostomy.js';
import { generateValidationEdgeCases } from './scenarios/validationEdgeCases.js';
import type { ScenarioOptions, SeedDataset, SeedObservation } from './types.js';

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
/**
 * `leak-cluster` is absent, and that is the plan's own sequencing rather than an
 * omission: it needs repeated leaks with shortening wear times and escalating
 * skin severity, and there are no appliance, leak or skin tables in the schema
 * at all. It is scheduled at P5 with the features it exercises.
 */
export const SCENARIO_NAMES = [
  'stable-ileostomy',
  'high-output-dehydration',
  'new-post-op',
  'colostomy-baseline',
  'validation-edge-cases',
] as const;
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
  /**
   * `MEASURED_METHOD_CODE`'s value, or `null` where it is unresolved.
   *
   * **Added because the seeder was writing a shape the application cannot
   * produce.** ADR-0018 as amended makes `method: null` at rest mean exactly
   * one thing — "this observation has no toggle", i.e. weight or resting heart
   * rate — and `toStoredMethod` writes `258104002` |Measured| for a measured
   * volumetric entry. Every measured row this package generated was therefore
   * asserting that no Measured/Estimated question applied to it, on 2,128 rows
   * of a seeded database, and a FHIR export would have emitted no
   * `Observation.method` for any of them.
   *
   * It survived because `apps/web` still reads a null as measured for
   * back-compat, so the demo looked right — and because the backfill migration
   * that made that reading sound says in terms that it "stops being true for
   * any row written after this migration". The seeder runs after it.
   *
   * Injected rather than imported for the same reason as the estimation code:
   * this package must not be the thing keeping a stale copy of a terminology
   * code alive (ADR-0018).
   */
  readonly measuredMethodCode: string | null;
}

export function generateScenario(name: ScenarioName, options: GenerateOptions): SeedDataset {
  switch (name) {
    case 'stable-ileostomy':
      return generateStableIleostomy(options);
    case 'high-output-dehydration':
      return generateHighOutputDehydration(options);
    case 'new-post-op':
      return generateNewPostOp(options);
    case 'colostomy-baseline':
      return generateColostomyBaseline(options);
    case 'validation-edge-cases':
      return generateValidationEdgeCases(options);
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
 * Deliberately `packages/core`'s own entry points — whichever one the row's
 * shape calls for, see `evaluateSeedObservation` — rather than a
 * reimplementation: sharing the module is what makes a rule change
 * automatically constrain the seed data too (ADR-0009). A local copy of the
 * rules would drift and the seeder would keep claiming validity it no longer
 * had.
 *
 * (This said "the same `validateVolumetricEntry`" until P3.S5 made the dispatch
 * two-way.)
 */
/**
 * The application's own rules over one generated row, through whichever entry
 * point that row's shape calls for.
 *
 * **The dispatch is the point, and getting it wrong was a live bug for the
 * length of one commit.** `validateVolumetricEntry` takes `rawValueMl: number`,
 * so a volumeless row — a voided-urine entry recorded by colour alone, which
 * P3.S5 made representable — arrived as `Number(null)`, which is `0`, which
 * Tier 1 correctly rejects as non-positive. The seeder would therefore have
 * refused to write a row the application accepts, reporting a rule violation
 * that existed only in this function.
 *
 * `validateVolumelessObservation` is the separate entry point CLAUDE.md names
 * for exactly this, "a separate entry point, not a flag, so no caller has to
 * know which rules stop applying" — and it enforces the rule that matters here:
 * `method` must be null, because a Measured/Estimated qualifier on an entry
 * with nothing to qualify is meaningless (and the database's CHECK agrees).
 */
function evaluateSeedObservation(
  observation: SeedObservation,
  dataset: SeedDataset,
  thresholds: VolumetricValidationThresholds,
  now: Date,
): VolumetricValidationResult {
  const timestamps = {
    field: 'valueQuantity.value' as const,
    effectiveDateTime: observation.effectiveDatetime,
    surgeryDate: dataset.profile.surgeryDate,
    now,
  };

  if (observation.valueQuantityValue === null) {
    // Mapped to the discriminator rather than passed as the SNOMED code: a
    // volumeless row must carry NO qualifier, and `validateVolumelessObservation`
    // reports `METHOD_NOT_APPLICABLE` when one is present. Passing `null`
    // unconditionally would have silenced that check — the generator could then
    // emit a colour-only urine entry with a Measured code, which the database's
    // own CHECK would then refuse at the writer with a far less useful message.
    return validateVolumelessObservation(
      { ...timestamps, method: observation.method === null ? null : 'estimated' },
      thresholds,
    );
  }

  return validateVolumetricEntry(
    {
      ...timestamps,
      rawValueMl: Number(observation.valueQuantityValue),
      method: observation.method === null ? 'measured' : 'estimated',
    },
    thresholds,
  );
}

export function findTier1Problems(
  dataset: SeedDataset,
  thresholds: VolumetricValidationThresholds,
  now: Date,
): ScenarioValidationProblem[] {
  const problems: ScenarioValidationProblem[] = [];

  for (const observation of dataset.observations) {
    const result = evaluateSeedObservation(observation, dataset, thresholds, now);

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
    // The same dispatch as Tier 1. A volumeless row has nothing to compare
    // against a plausibility bound, so `validateVolumelessObservation` returns
    // `pass` rather than an empty `warn` — meaning a colour-only urine entry
    // never counts here, which is correct and not an oversight.
    const result = evaluateSeedObservation(observation, dataset, thresholds, now);

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
