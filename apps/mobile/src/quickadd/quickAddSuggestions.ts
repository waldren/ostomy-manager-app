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
import {
  ESTIMATION_METHOD_CODE,
  MEASURED_METHOD_CODE,
  type MeasuredOrEstimated,
} from '@ostomy/core/validation';

import {
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
} from '../entry/observationCodes';

/**
 * Quick-Add widget generation (P3.S4, SRS §3.1 "Chart by Exception & Dynamic
 * Widgets", Epic 3).
 *
 * No React and no database in this module, following `../entry/`'s shape: the
 * rules below are testable as functions and the screen is left with rendering.
 *
 * ## A widget is a past entry of the patient's own, repeated
 *
 * The grouping key is **every field the patient asserted** — code, canonical
 * value, Measured/Estimated, fluid type, urine colour, entered measurement
 * system. Nothing is bucketed, averaged or rounded into it, and that is the
 * central safety property rather than a simplification:
 *
 * - **A tap must log a value the patient has actually entered.** Bucketing
 *   345/350/355 mL into "350" would put a number on the dashboard that the
 *   patient never recorded, and a one-tap button is the worst possible place
 *   to introduce one — there is no form in front of it to notice it in. §3.1's
 *   "chart by exception" is about the routine entry a patient makes
 *   repeatedly, and a patient using a 350 mL mug types 350 every time, so
 *   exact grouping is also what actually matches the use case.
 * - **The fluid type and the colour are part of the routine.** A 250 mL coffee
 *   and a 250 mL glass of water are different entries, and collapsing them
 *   would make a tap log a categorisation the patient did not choose.
 *
 * ## The Measured/Estimated toggle is carried, never defaulted
 *
 * ADR-0018 makes the toggle mandatory on every volumetric entry, and a
 * one-tap log has no form to ask in. The only answer that invents nothing is
 * the one the patient gave on the entries the widget was generated from — so
 * `method` is part of the widget's identity, and
 * `QuickAddWidgets` renders it on the face of the button. A patient tapping
 * "350 mL · Measured" is repeating an assertion they have made at least twice.
 *
 * Defaulting either way was considered and rejected. "Measured" would assert a
 * measurement nobody made; "Estimated" would downgrade an entry the patient
 * had measured. Both invent an answer to the one question §3.1 calls
 * mandatory.
 *
 * ## What is deliberately NOT here
 *
 * - **Review, edit, pin and remove** (§3.10, Epic 15) belong to P4.S3's
 *   preferences work. Their absence is why this module needs no table and no
 *   sync surface at all: a suggestion is *derived* state, recomputed from the
 *   local store, so there is nothing to keep in step with anything.
 * - **Custom default container sizes** (Epic 3's third story) are also P4.S3.
 *   The Add Intake screen's quick-select sizes (AC 2.3 AC2) already exist and
 *   are a different feature: a fixed value set, not the patient's history.
 * - **Meals.** A meal's identity is free text plus a size, so "most frequent
 *   recent entry" over it is a much weaker match than over a volume, and
 *   §3.1's own framing is volumetric. Deferred rather than guessed at.
 */

/** The three codes a widget may be generated for. Weight and heart rate are excluded: neither is a routine volumetric entry, and `method` is `null` for them by construction. */
export const QUICK_ADD_CODES: readonly string[] = [
  STOMA_OUTPUT_LOINC_CODE,
  FLUID_INTAKE_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
];

/**
 * How far back "recent" reaches.
 *
 * Bounded on purpose, and §3.10's own wording is the reason: a patient must
 * not be "stuck with a suggestion that no longer matches their routine". A
 * window is what makes a widget disappear when the routine behind it stops,
 * with no management UI and nothing for the patient to clean up — which is
 * what lets P4.S3's pin/remove work be genuinely deferred rather than missed.
 *
 * Fourteen days: long enough that a routine followed a few times a week
 * clears `MINIMUM_OCCURRENCES`, short enough that a post-operative diet
 * change drops the old entries within a fortnight. Not a clinical number and
 * not derived from one — if it needs to be configurable, that is preferences
 * work, not a threshold (`validation_thresholds` is for rules that gate a
 * save, and nothing here gates anything).
 */
export const RECENT_WINDOW_DAYS = 14;

/**
 * How many times an entry must recur before it is offered as one tap.
 *
 * Two, and the floor matters more than the number: at one, **a single
 * mistyped entry becomes a one-tap button**. A patient who fat-fingers
 * 2,000 mL instead of 200 would be offered it on the dashboard for a
 * fortnight, which is the one failure this feature could introduce into the
 * data rather than merely into the UI.
 */
export const MINIMUM_OCCURRENCES = 2;

/**
 * How many widgets the dashboard shows.
 *
 * Three. The dashboard already carries four entry buttons, a pending-count
 * line and up to three notices, and a list long enough to scroll is not
 * "a single tap" any more. Ranked by frequency, so the three shown are the
 * patient's actual routine rather than the first three found.
 */
export const MAX_SUGGESTIONS = 3;

/** A grouped row as the local store reports it — see `../db/repositories/quickAddRepository.ts`. */
export interface QuickAddCandidate {
  readonly code: string;
  /** Canonical mL as stored, verbatim. `null` only on a colour-only urine entry. */
  readonly valueQuantityValue: string | null;
  /** The stored SNOMED qualifier, or `null`. Mapped back to the toggle below, never read as a label. */
  readonly method: string | null;
  readonly fluidTypeCode: string | null;
  readonly urineColorCode: string | null;
  readonly enteredMeasurementSystem: MeasurementSystem;
  readonly occurrences: number;
  /** The most recent `effective_datetime` in the group, for the frequency tiebreak. */
  readonly lastEnteredAt: string;
}

interface SuggestionBase {
  /** Stable within a render, derived from the grouping key — not a row id, because a suggestion is not a row. */
  readonly key: string;
  readonly code: string;
  readonly enteredMeasurementSystem: MeasurementSystem;
  readonly occurrences: number;
  readonly lastEnteredAt: string;
}

/**
 * A suggestion, in one of the two shapes the offline write path accepts.
 *
 * A discriminated union rather than one type with optional fields, for the
 * reason `../db/offlineWrites.ts` gives for keeping `VolumelessUrineFields`
 * separate: the rule set follows from which shape it is, so no caller has to
 * remember that a volumeless entry has no `method` and a volumetric one must
 * have one. `logQuickAdd` switches on `kind` and the two arms call the two
 * matching `enqueue…` functions.
 */
export type QuickAddSuggestion =
  | (SuggestionBase & {
      readonly kind: 'volumetric';
      /** Canonical mL, verbatim from the entries this was generated from. */
      readonly canonicalValue: string;
      readonly method: MeasuredOrEstimated;
      readonly fluidTypeCode: string | null;
      readonly urineColorCode: string | null;
    })
  | (SuggestionBase & {
      readonly kind: 'volumeless-urine';
      /** The colour is the whole entry (AC 12.1 AC2). */
      readonly urineColorCode: string;
    });

function candidateKey(candidate: QuickAddCandidate): string {
  // Every asserted field, so two different routines can never collide onto one
  // widget. Joined with a character none of these values may contain.
  return [
    candidate.code,
    candidate.valueQuantityValue ?? '',
    candidate.method ?? '',
    candidate.fluidTypeCode ?? '',
    candidate.urineColorCode ?? '',
    candidate.enteredMeasurementSystem,
  ].join('|');
}

/**
 * Maps a volumetric row's stored `method` back to the toggle, or `undefined`
 * if this client cannot say what it means.
 *
 * Takes `string | null` and handles both rejections here, deliberately as one
 * rule rather than two. A mutation sweep found the alternative: an explicit
 * `method === null` guard in `toSuggestion` ahead of this call was
 * **behaviourally redundant** — deleting it and coercing with `?? ''` left the
 * whole suite green, because an empty string matches neither code and is
 * dropped anyway. A branch no test can distinguish is a branch that reads as a
 * second rule while being the same one, so the two are now one.
 *
 * Both rejections trace to ADR-0018, in opposite directions:
 *
 * - **`null`** at rest means "this observation has no toggle" — weight or
 *   resting heart rate. On a row that *has* an amount it is a contradiction
 *   (SRS §3.1 makes the toggle mandatory on every volumetric entry), reachable
 *   from a row written before the amendment.
 * - **An unrecognised code** is a row this client does not understand: written
 *   rows keep whatever code they were written with, and "changing either is a
 *   data migration, not an edit".
 *
 * Either way, `undefined` drops the candidate rather than guessing. Offering a
 * one-tap button that re-asserts a qualifier we cannot name is strictly worse
 * than offering nothing — there is no form in front of it to notice in.
 */
function toToggle(method: string | null): MeasuredOrEstimated | undefined {
  if (method === null) return undefined;
  if (MEASURED_METHOD_CODE.resolved && method === MEASURED_METHOD_CODE.code) return 'measured';
  if (ESTIMATION_METHOD_CODE.resolved && method === ESTIMATION_METHOD_CODE.code) return 'estimated';
  return undefined;
}

/**
 * Turns one grouped row into a suggestion, or `undefined` if it cannot become
 * a tappable entry.
 *
 * Four rejections, each the mirror of a rule the write path or the schema
 * already enforces — so a suggestion that survives this is one
 * `enqueueVolumetricObservationCreate` or `enqueueVolumelessUrineCreate` will
 * accept, rather than one that throws at the moment of the tap.
 */
export function toSuggestion(candidate: QuickAddCandidate): QuickAddSuggestion | undefined {
  const key = candidateKey(candidate);
  const base = {
    key,
    code: candidate.code,
    enteredMeasurementSystem: candidate.enteredMeasurementSystem,
    occurrences: candidate.occurrences,
    lastEnteredAt: candidate.lastEnteredAt,
  };

  if (candidate.valueQuantityValue === null) {
    // No amount: the colour-only urine entry, and nothing else. `../db/schema.ts`
    // has a CHECK making a row with neither an amount nor a colour unwritable,
    // and another confining a colour to code 9187-6, so this arm should be
    // reachable only for urine — but both are checked rather than assumed,
    // because a widget that logged an empty observation would be a silent data
    // defect rather than a crash.
    if (candidate.urineColorCode === null) return undefined;
    if (candidate.code !== VOIDED_URINE_LOINC_CODE) return undefined;
    // `method` must be absent too: ADR-0018 fixes `null` at rest to mean
    // "this observation has no toggle", and there is nothing for
    // Measured/Estimated to describe on an entry with no number.
    if (candidate.method !== null) return undefined;
    return { ...base, kind: 'volumeless-urine', urineColorCode: candidate.urineColorCode };
  }

  // An amount: the toggle is mandatory (SRS §3.1), and a qualifier this client
  // cannot read — absent or unrecognised — drops the candidate rather than
  // being re-asserted blindly. One check, for the reason `toToggle` records.
  const method = toToggle(candidate.method);
  if (method === undefined) return undefined;

  return {
    ...base,
    kind: 'volumetric',
    canonicalValue: candidate.valueQuantityValue,
    method,
    fluidTypeCode: candidate.fluidTypeCode,
    urineColorCode: candidate.urineColorCode,
  };
}

/**
 * The widgets to show, most-repeated first.
 *
 * Ties break on recency, so two routines a patient follows equally often show
 * the one they are currently doing. Without the tiebreak the order would come
 * from whatever the query happened to return, which makes the dashboard
 * reorder itself for no reason the patient can see.
 */
export function rankQuickAddSuggestions(
  candidates: readonly QuickAddCandidate[],
  options: { minimumOccurrences?: number; limit?: number } = {},
): QuickAddSuggestion[] {
  const minimum = options.minimumOccurrences ?? MINIMUM_OCCURRENCES;
  const limit = options.limit ?? MAX_SUGGESTIONS;

  return candidates
    .filter((candidate) => candidate.occurrences >= minimum)
    .flatMap((candidate) => {
      const suggestion = toSuggestion(candidate);
      return suggestion === undefined ? [] : [suggestion];
    })
    .sort(
      (a, b) =>
        b.occurrences - a.occurrences || b.lastEnteredAt.localeCompare(a.lastEnteredAt) || 0,
    )
    .slice(0, limit);
}

/**
 * The oldest `effective_datetime` a candidate may carry, as a wire instant.
 *
 * Computed from a passed-in `now` rather than read from the clock, so the
 * window is testable and so a device whose clock has just been corrected
 * (ADR-0019) does not get a different window from the one its entries were
 * written against.
 */
export function recentWindowStart(now: Date, days: number = RECENT_WINDOW_DAYS): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}
