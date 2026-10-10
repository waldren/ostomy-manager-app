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

import { SAFETY_RANGE_TYPES } from '../admin/config/admin-default-range-wire';

/**
 * Which range is in force for a patient, and which clinical default seeds a
 * suggestion for them today (P4.S2 slice 2, SRS §3.9).
 *
 * Pure, and taking every input as an argument — the clock included — for the
 * reason `apps/api/src/onboarding/surgery-date.ts` records: a rule that reads
 * the ambient clock can only be tested at whatever time the suite runs.
 */

/** §3.9's order, highest first. Index 0 wins. */
const PROVENANCE_PRECEDENCE = [
  'PHYSICIAN_SET',
  'PATIENT_SET',
  'PATIENT_CONFIRMED_SUGGESTION',
  'CLINICAL_DEFAULT',
] as const;

export type RangeProvenanceName = (typeof PROVENANCE_PRECEDENCE)[number];

/**
 * Whether a range type may seed a patient range at all.
 *
 * **This is the consumer `SAFETY_RANGE_TYPES` was added without**, and the
 * comment that introduced it said exactly where it would land: "the exclusion
 * that enforces it will be keyed on a literal, and until now that literal
 * appeared nowhere in code — only in two prose comments in `schema.prisma`. An
 * implementer greps, finds comments, retypes the string, and a typo means the
 * exclusion silently does not fire and a patient gets an adjustable red-flag
 * bound."
 *
 * `heart_rate_red_flag_bpm` lives in `clinical_default_ranges` because §3.11
 * manages it there (#94), and it is not patient-adjustable. That table has no
 * `patient_adjustable` column, so the property has to be structural: the row
 * exists and nothing derives a patient range from it. Importing the constant
 * rather than retyping the string is the whole point.
 */
export function isSuggestableRangeType(rangeType: string): boolean {
  return !(SAFETY_RANGE_TYPES as readonly string[]).includes(rangeType);
}

/**
 * Whole days from the surgery date to today, both as `YYYY-MM-DD`.
 *
 * Calendar dates on both sides, never instants. `apps/api`'s Tier 1 bound
 * learned that the hard way (ADR-0016 Amendment 1): comparing an instant
 * against a `@db.Date` is wrong by the patient's UTC offset, and there it
 * hard-blocked real entries for everyone east of UTC.
 *
 * ## The residual imprecision here, and why it is acceptable
 *
 * The server does not know the patient's current zone. Observations carry one
 * per row (ADR-0016) but a range lookup is not an observation, so `today` is
 * the server's UTC date and a patient far from UTC may cross a window boundary
 * up to a day early or late.
 *
 * That is tolerable **here** and was not tolerable there, and the difference is
 * the consequence rather than the arithmetic: crossing from the 0-30 window to
 * the 31-90 one a day early changes a suggested upper bound from 1,500 mL to
 * 1,200 mL on a value the patient is invited to edit, while the Tier 1 bound
 * refused to save their entry at all. If a later sprint gives this surface the
 * patient's zone, this is the function to pass it to.
 */
export function daysSinceSurgery(surgeryDate: string, today: string): number {
  const surgery = Date.parse(`${surgeryDate}T00:00:00.000Z`);
  const current = Date.parse(`${today}T00:00:00.000Z`);
  return Math.floor((current - surgery) / 86_400_000);
}

export interface DefaultRangeWindow {
  readonly rangeType: string;
  /**
   * `null` means "from day 0", which is what #97's exclusion constraint already
   * encodes: `int4range(COALESCE("min_days_post_op", 0), ...)`.
   *
   * The column is nullable and the model's doc comment explains only the NULL
   * `maxDaysPostOp` case, so this is easy to read as non-null — the first
   * version of this file did, and a NULL row would then have matched no day at
   * all (`daysPostOp >= null` is false), silently producing no suggestion rather
   * than erroring. Coalescing here keeps the selection and the constraint
   * agreeing about what a row covers.
   */
  readonly minDaysPostOp: number | null;
  /** `null` is open-ended — the last window, which every patient eventually reaches. */
  readonly maxDaysPostOp: number | null;
}

/**
 * The default row whose post-operative window contains `daysPostOp`.
 *
 * Both bounds inclusive, matching the column semantics #97's exclusion
 * constraint encodes (`int4range` is half-open, hence that migration's `+ 1`).
 *
 * `undefined` rather than a fallback when nothing matches, and the distinction
 * carries weight: a missing window means no suggestion, which the caller must
 * render as "we have no suggestion" rather than as a blank field or a zero. The
 * seeded windows are contiguous from day 0 and open-ended at the end, and a
 * test asserts that, so the only ways to reach `undefined` are a negative
 * `daysPostOp` — a surgery date in the future, which onboarding refuses — or a
 * range type with no defaults seeded yet, which is exactly the state weight and
 * heart rate are in until P6 and P7.
 */
export function pickWindowForDay<T extends DefaultRangeWindow>(
  windows: readonly T[],
  daysPostOp: number,
): T | undefined {
  return windows.find(
    (window) =>
      daysPostOp >= (window.minDaysPostOp ?? 0) &&
      (window.maxDaysPostOp === null || daysPostOp <= window.maxDaysPostOp),
  );
}

export interface RangeCandidate {
  readonly provenance: RangeProvenanceName;
  /** Only `ACTIVE` rows are ever candidates — see `resolveEffectiveRange`. */
  readonly status: string;
  readonly clientUpdatedAt: Date;
}

/**
 * Which of a patient's ranges for one range type is actually in force.
 *
 * ## Why several can be ACTIVE at once
 *
 * `p1-s3-schema-coverage.md` left this open for "whichever sprint builds the
 * range-precedence query", between two readings: at most one ACTIVE row per
 * `(patient, range_type)`, or "whichever ACTIVE row has the highest-precedence
 * provenance wins, possibly among several". It is the second, and the SRS
 * settles it rather than taste.
 *
 * §3.0: "The patient may edit these, but edits that diverge from a
 * physician-entered default are flagged." The edit is allowed and flagged, not
 * refused — so a patient-set row and a physician-set row exist together. §3.9
 * then says physician-set is highest precedence and "a physician-entered target
 * is only ever flagged as diverging", so the physician's value stays in force
 * while the patient's is recorded. A unique index over `(patient, range_type)`
 * would make that state unrepresentable and force the patient's edit to destroy
 * the physician's value, which is the one outcome AC 4 forbids.
 *
 * What IS enforced, by a partial unique index in this slice's migration, is at
 * most one ACTIVE row per `(patient, range_type, provenance)`. Two simultaneous
 * patient-set values for one range type is not a state with a meaning; the
 * newer supersedes the older.
 *
 * ## PROPOSED is never a candidate
 *
 * AC 2, and the reason `RangeStatus` exists as a column rather than being
 * inferred from provenance and a nullable timestamp: "No value becomes an active
 * threshold without a human confirming it." A proposal is persisted so
 * Preferences can list it (§3.10), and filtered out here.
 */
export function resolveEffectiveRange<T extends RangeCandidate>(
  candidates: readonly T[],
): T | undefined {
  const active = candidates.filter((candidate) => candidate.status === 'ACTIVE');

  return active.reduce<T | undefined>((winner, candidate) => {
    if (winner === undefined) return candidate;

    const byProvenance =
      PROVENANCE_PRECEDENCE.indexOf(candidate.provenance) -
      PROVENANCE_PRECEDENCE.indexOf(winner.provenance);
    if (byProvenance !== 0) return byProvenance < 0 ? candidate : winner;

    /**
     * Same provenance, which the unique index makes unreachable through this
     * application's own writes — so this is the tie-break for a row that
     * arrived another way, and it is deliberately the newer one rather than
     * "either". Returning an arbitrary winner would make the effective range
     * depend on row order, which is the kind of non-determinism that is
     * invisible until two readers disagree about a patient's threshold.
     */
    return candidate.clientUpdatedAt > winner.clientUpdatedAt ? candidate : winner;
  }, undefined);
}

/**
 * Whether a patient's own value diverges from a physician-set one (AC 4, §3.0).
 *
 * Reported, never acted on. The physician's value stays in force — that is
 * `resolveEffectiveRange`'s job — and this is what lets a surface say so instead
 * of silently showing the patient a number they did not choose.
 */
export function divergesFromPhysicianValue(
  candidates: readonly { readonly provenance: RangeProvenanceName; readonly status: string }[],
): boolean {
  const active = candidates.filter((candidate) => candidate.status === 'ACTIVE');
  const hasPhysician = active.some((candidate) => candidate.provenance === 'PHYSICIAN_SET');
  const hasPatient = active.some(
    (candidate) =>
      candidate.provenance === 'PATIENT_SET' ||
      candidate.provenance === 'PATIENT_CONFIRMED_SUGGESTION',
  );
  return hasPhysician && hasPatient;
}
