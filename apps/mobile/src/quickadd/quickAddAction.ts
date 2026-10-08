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
  hasWarnings,
  isBlocked,
  validateVolumelessObservation,
  validateVolumetricEntry,
  type VolumetricValidationThresholds,
} from '@ostomy/core/validation';

import { STOMA_OUTPUT_VALUE_FIELD } from '../entry/useStomaOutputEntry';

import type { QuickAddSuggestion } from './quickAddSuggestions';

/**
 * What a Quick-Add tap should do (P3.S4).
 *
 * ## The rule, and why it is this rather than a dialog
 *
 * §5.1: "Quick-Add widget taps must resolve immediately, without a loading
 * state." And SRS §3.8 / AC 13.2 AC1: a Tier 2 warning asks once and then
 * saves, and **must never become a block**. Those two pull in opposite
 * directions on a button with no screen behind it — a confirmation prompt is
 * not a loading state, but a tap that opens a prompt is not one tap either,
 * and a tap that saved *through* a warning without asking would turn Tier 2
 * into something the patient never sees.
 *
 * So: **a tap that validates cleanly logs; anything else opens the draft.**
 * The widget already has "open as a draft" as its second action (Epic 3), so
 * the fallback is a path the patient can already see rather than an invented
 * one — and the entry screen is where a warning can be shown with its text, a
 * confirmation, and the amount still editable. Nothing is silently dropped and
 * nothing is silently confirmed.
 *
 * Three things route to the draft:
 *
 * - **Tier 1 blocked.** Reachable even though the value was saved before:
 *   thresholds are admin-managed configuration and can tighten between the
 *   entry and the tap. The entry screen names the failing field; a widget
 *   cannot.
 * - **Tier 2 warning.** Above, and this is the case that will actually occur —
 *   a high-output patient's genuine routine trips the >2,000 mL warning, which
 *   is exactly the data the care team most needs and must stay one tap away
 *   from being logged.
 * - **No thresholds cached.** `validation_thresholds_cache` is deliberately
 *   unseeded (CLAUDE.md), so an un-fetched cache means there is nothing to
 *   validate against. The entry screens already refuse to save in that state
 *   and say so; a widget silently saving would be the one path that validated
 *   against nothing. This applies to the colour-only urine entry too, which
 *   has no value for a bound to be about but still has a timestamp — and
 *   ADR-0019's clock-skew allowance, which Tier 1 checks every entry against,
 *   is itself one of the cached thresholds.
 *
 * ## No network, by construction
 *
 * Everything this decides reads from arguments: the suggestion came from the
 * local store, the thresholds from the local cache, the clock from the device.
 * That is the testable half of §5.1 — it proves a tap cannot wait on a
 * request, which is a different claim from "it feels instant on a phone", and
 * only a device can answer the second (CLAUDE.md's hardware caveat).
 */
export type QuickAddDecision =
  /** Validates cleanly. Write it and confirm, with no screen in between. */
  | { readonly kind: 'log' }
  /**
   * Hand it to the entry screen pre-filled, where the warning or error has
   * room to be read and the amount is still editable.
   */
  | { readonly kind: 'open-draft'; readonly reason: 'blocked' | 'warns' | 'no-thresholds' };

export interface QuickAddDecisionInput {
  readonly suggestion: QuickAddSuggestion;
  /** `null` when the cache has never been filled — see above. */
  readonly thresholds: VolumetricValidationThresholds | null;
  /**
   * Still `null` until P4.S1's onboarding captures it, as on every entry
   * screen.
   *
   * No `measurementSystem` field, deliberately: a suggestion's value is
   * already canonical mL, so there is nothing to convert and the ADR-0004 trap
   * the entry screens have to avoid cannot arise here. An unused field would
   * read as if the decision consulted the preference.
   */
  /** The patient's surgery date as `YYYY-MM-DD`, from the local profile, or `null` when there is none. A calendar date, because the Tier 1 rule compares calendar days (`entryTimestamp.ts`). */
  readonly surgeryDate: string | null;
  /** The zone this entry is being made in (ADR-0016), so the surgery-date rule compares the patient's own calendar day. */
  readonly enteredTimezone: string;
  readonly now: Date;
}

/**
 * Runs the same two tiers the entry screens run, over the entry a tap would
 * create.
 *
 * Deliberately not a cheaper check. Client validation is a UX affordance and
 * the server re-enforces everything (CLAUDE.md), so the purpose of running it
 * here is the same as on a form: tell the patient now rather than after a
 * round-trip — and on this path, route them somewhere they can act.
 */
export function decideQuickAdd(input: QuickAddDecisionInput): QuickAddDecision {
  if (input.thresholds === null) return { kind: 'open-draft', reason: 'no-thresholds' };

  if (input.suggestion.kind === 'volumeless-urine') {
    // A colour with no number: `validateVolumelessObservation` is the rule set
    // for it — a separate entry point, not a flag, so nothing here has to know
    // which rules stop applying (CLAUDE.md).
    const result = validateVolumelessObservation(
      {
        field: STOMA_OUTPUT_VALUE_FIELD,
        // `null` by construction on this arm, and passed rather than assumed:
        // the validator's own comment says its job is to REPORT the
        // contradiction of a method on a volumeless entry. The suggestion type
        // has no `method` to pass, which is the same guarantee one level up.
        method: null,
        effectiveDateTime: input.now,
        surgeryDate: input.surgeryDate,
        enteredTimezone: input.enteredTimezone,
        now: input.now,
      },
      input.thresholds,
    );
    // No Tier 2 arm: `validateVolumelessObservation` returns tier2 `pass`
    // unconditionally, because no volume means nothing for a plausibility
    // bound to be about. Checking `hasWarnings` here would read as if it
    // could warn.
    return isBlocked(result) ? { kind: 'open-draft', reason: 'blocked' } : { kind: 'log' };
  }

  const result = validateVolumetricEntry(
    {
      field: STOMA_OUTPUT_VALUE_FIELD,
      // Already canonical mL — it is the stored value of the patient's own
      // earlier entries, not something typed into a field in a display unit.
      // That is why `measurementSystem` is NOT used to convert here, and the
      // ADR-0004 trap the entry screens have to avoid does not apply.
      rawValueMl: Number(input.suggestion.canonicalValue),
      method: input.suggestion.method,
      effectiveDateTime: input.now,
      surgeryDate: input.surgeryDate,
      enteredTimezone: input.enteredTimezone,
      now: input.now,
    },
    input.thresholds,
  );

  if (isBlocked(result)) return { kind: 'open-draft', reason: 'blocked' };
  if (hasWarnings(result)) return { kind: 'open-draft', reason: 'warns' };
  return { kind: 'log' };
}
