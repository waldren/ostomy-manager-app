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

import type { MeasurementSystem } from '@ostomy/core/units';

/**
 * The shapes a scenario produces.
 *
 * Plain data, with no Prisma types and no database connection anywhere in
 * this package. ADR-0009 decided the seeder writes through Prisma rather
 * than through the API; this module is the half of that which *generates*
 * and *validates*, and `apps/api/src/seed/` is the half that writes. The
 * split is not a hedge against the ADR — it is where the seam has to fall,
 * because the Prisma client is generated into `apps/api/src/generated/prisma`
 * by that app's own schema, and a package importing it would depend on the
 * app rather than the other way round.
 *
 * What it buys: every generation rule below is unit-testable with no
 * container, and the writer is small enough to read in one sitting.
 *
 * ## Synthetic by construction
 *
 * ADR-0009's compliance review is binding on this file. No value here is
 * derived from, sampled from, or shaped to match a real patient record.
 * There are deliberately **no names, no dates of birth, and no contact
 * details** in these types at all — not "generated" ones. The schema does
 * not require them for this scenario, and a field that does not exist cannot
 * later be populated from a production dump by someone in a hurry.
 */

/** LOINC 79560-9 — stoma output. The only observation code P2 exchanges. */
export const STOMA_OUTPUT_LOINC_CODE = '79560-9';

export type SeedOstomyType = 'ILEOSTOMY' | 'COLOSTOMY';

/**
 * A patient identified only by the OIDC subject their tokens carry.
 *
 * `oidcSubject` is what makes a seeded patient reachable: `JwtAuthGuard`
 * looks up `WHERE oidc_subject = $1` from the token's `sub` claim, and a
 * database with observations but no matching subject answers every request
 * with `PATIENT_NOT_PROVISIONED` — which is exactly the state the Gate B
 * rehearsal found.
 */
export interface SeedPatient {
  readonly id: string;
  readonly oidcSubject: string;
}

export interface SeedProfile {
  readonly id: string;
  readonly patientId: string;
  readonly ostomyType: SeedOstomyType;
  /** A calendar date, not an instant — it is the Tier 1 lower bound on entry timestamps (SRS §3.0, §3.8). */
  readonly surgeryDate: Date;
  readonly measurementSystem: MeasurementSystem;
  readonly clientUpdatedAt: Date;
}

/**
 * One observation row, in canonical units.
 *
 * `valueQuantityValue` is a decimal **string**, matching the wire contract's
 * and the mobile client's treatment of the same value: the column is
 * `DECIMAL(12,4)` and ADR-0005 requires stored values to keep their entered
 * precision, so the number never round-trips through a float on its way in.
 */
export interface SeedObservation {
  readonly id: string;
  readonly patientId: string;
  readonly code: string;
  readonly valueQuantityValue: string;
  readonly valueQuantityUnit: 'mL' | 'kg';
  readonly effectiveDatetime: Date;
  /** `null` for measured; the SNOMED estimation code for estimated (ADR-0018). */
  readonly method: string | null;
  readonly enteredMeasurementSystem: MeasurementSystem;
  /** IANA zone captured at entry (ADR-0016). */
  readonly enteredTimezone: string;
  /** `YYYY-MM-DD` in that zone, derived from the SAME shared helper the server and the phone use. */
  readonly localDate: string;
  readonly clientUpdatedAt: Date;
}

export interface SeedDataset {
  readonly scenario: string;
  readonly patient: SeedPatient;
  readonly profile: SeedProfile;
  readonly observations: readonly SeedObservation[];
}

export interface ScenarioOptions {
  /**
   * The OIDC subject the seeded patient answers to. Required, with no
   * default: a dataset nobody can sign in as is a dataset that cannot be
   * demonstrated, and silently picking one would produce a database that
   * looks seeded and behaves like an empty one.
   */
  readonly oidcSubject: string;
  /**
   * Fixed RNG seed. Defaulted per scenario so `--scenario stable-ileostomy`
   * alone is reproducible, and overridable so a second, differently-shaped
   * dataset can be produced from the same generator.
   */
  readonly seed?: number;
  /**
   * "Now". Timestamps are generated as offsets from this rather than from
   * fixed dates, so the dataset never ages into irrelevance and a dashboard
   * always has recent data (`docs/deployment-development.md`). Injected
   * rather than read from the clock so the generator stays a pure function.
   */
  readonly now: Date;
  /** IANA zone the synthetic entries were "made" in. */
  readonly timeZone?: string;
}
