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
import { ozToMl } from '@ostomy/core/units';
import {
  ESTIMATION_METHOD_CODE,
  isBlocked,
  MAX_VALUE_DECIMAL_PLACES,
  MEASURED_METHOD_CODE,
  validateVolumetricEntry,
  type MeasuredOrEstimated,
  type VolumetricValidationThresholds,
  type ValidationError,
  type ValidationWarning,
} from '@ostomy/core/validation';

/**
 * The Add Output screen's decision logic, with no React and no database in
 * it — so every rule below is testable as a function, and the screen is left
 * with rendering.
 *
 * ## What the screen may and may not decide
 *
 * Nothing here invents a threshold (CLAUDE.md), and nothing here decides
 * that an entry is fine because the server would probably accept it. Client
 * validation is a **UX affordance only**: every rule is re-enforced
 * server-side on write and on every synced operation, so the purpose of
 * running it here is to tell the patient now rather than after a round-trip.
 */

/** The LOINC code for stoma output. P2 accepts only this one (docs/sync-contract.md §7.2). */
export const STOMA_OUTPUT_LOINC_CODE = '79560-9';

/** The field id Tier 1 errors are reported against — the wire spelling, so a local error and a server rejection name the same thing. */
export const STOMA_OUTPUT_VALUE_FIELD = 'valueQuantity.value';

export interface EntryDraft {
  /** Exactly what the patient typed. Never parsed here — see `NumericField`. */
  readonly amountText: string;
  /** `undefined` until the patient answers. Never defaulted (SRS §3.1's mandatory toggle). */
  readonly method: MeasuredOrEstimated | undefined;
  readonly effectiveDateTime: Date;
}

export type EntryCheck =
  /** Tier 1 failed. The save is blocked and these are the fields to mark. */
  | { readonly kind: 'blocked'; readonly errors: readonly ValidationError[] }
  /**
   * D4. The entry is otherwise valid, but an Estimated one cannot be
   * represented yet — `ESTIMATION_METHOD_CODE` is `{ resolved: false }`, and
   * `@ostomy/core/validation` says in as many words not to invent a code.
   *
   * This is deliberately NOT modelled as a Tier 1 error. Tier 1 means the
   * patient entered something structurally impossible; this entry is
   * perfectly good and the software cannot store it. Routing it through
   * `validationErrors` would tell someone to fix an entry that is not wrong,
   * and would put a permanent-looking message in the catalog for a state
   * that disappears the moment D4 resolves.
   */
  | { readonly kind: 'estimated-unavailable' }
  /** Tier 2 tripped. The save proceeds on confirmation and is never blocked (SRS §3.8, AC 13.2 AC1). */
  | { readonly kind: 'needs-confirmation'; readonly warnings: readonly ValidationWarning[] }
  | { readonly kind: 'ready' };

export interface CheckInput {
  readonly draft: EntryDraft;
  readonly measurementSystem: MeasurementSystem;
  readonly thresholds: VolumetricValidationThresholds;
  readonly surgeryDate: Date | null;
  readonly now: Date;
}

/**
 * Runs both tiers over a draft and says what the screen should do next.
 *
 * Order matters and is not arbitrary: Tier 1 first, because a blocked entry
 * has nothing to confirm; then D4, because there is no point asking a patient
 * to confirm a value on an entry that cannot be saved either way; then Tier 2.
 */
export function checkEntry(input: CheckInput): EntryCheck {
  const result = validateVolumetricEntry(
    {
      field: STOMA_OUTPUT_VALUE_FIELD,
      // Canonical mL before validation, ALWAYS (ADR-0004). The thresholds are
      // canonical-mL bounds, so handing them an imperial number compares 80
      // against ~2000 and silently never warns for an imperial patient —
      // which is the exact defect `@ostomy/core/validation`'s tier2 comment
      // records having already been made once.
      rawValueMl: toCanonicalMl(input.draft.amountText, input.measurementSystem),
      method: input.draft.method ?? null,
      effectiveDateTime: input.draft.effectiveDateTime,
      surgeryDate: input.surgeryDate,
      now: input.now,
    },
    input.thresholds,
  );

  if (isBlocked(result) && result.tier1.outcome === 'blocked') {
    return { kind: 'blocked', errors: result.tier1.errors };
  }

  if (input.draft.method === 'estimated' && !ESTIMATION_METHOD_CODE.resolved) {
    return { kind: 'estimated-unavailable' };
  }

  if (result.tier2.outcome === 'warn') {
    return { kind: 'needs-confirmation', warnings: result.tier2.warnings };
  }

  return { kind: 'ready' };
}

/**
 * The patient's typed text as canonical mL, or the text itself when it is not
 * a number.
 *
 * Returning the raw text rather than `NaN` for unparseable input is
 * deliberate: `VolumetricEntryInput.rawValueMl` is typed `unknown` precisely
 * so Tier 1 can distinguish "not a number" from a number that happens to be
 * out of range, and coercing here would collapse `VALUE_NOT_NUMERIC` into
 * whatever `NaN` compares as.
 *
 * An empty string is returned as-is for the same reason — `Number('')` is 0,
 * which would report a blank field as `VALUE_NOT_POSITIVE` ("Enter an amount
 * above 0") when the patient has simply not typed anything yet.
 */
export function toCanonicalMl(amountText: string, system: MeasurementSystem): unknown {
  const trimmed = amountText.trim();
  if (trimmed === '') return trimmed;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return trimmed;

  return system === 'metric' ? parsed : toStorableScale(ozToMl(parsed));
}

/**
 * Rounds a CONVERTED value to the canonical column's scale.
 *
 * Applied only to the conversion result, never to what a patient typed, and
 * the distinction is the whole point. `ozToMl(80)` is `2365.882365` — six
 * fractional digits, which Tier 1 correctly refuses as unstorable in
 * `DECIMAL(12,4)`. Without this, **every imperial entry is blocked**, and the
 * message the patient gets is "Use no more than 4 numbers after the decimal
 * point" for having typed the whole number `80`.
 *
 * A metric entry is deliberately left alone: there, five decimal places are
 * five decimal places the patient actually typed, and Tier 1 telling them so
 * is correct. Rounding those silently is exactly what ADR-0005 and
 * `representableRange.ts` forbid — stored values keep their entered
 * precision.
 *
 * The rounding is a representability step, not a clinical one. At the fourth
 * decimal of a millilitre it is far below anything measurable; ADR-0005's
 * clinical display rounding (whole units for volume) is a separate rule
 * applied at render time and is not this.
 */
function toStorableScale(value: number): number {
  const factor = 10 ** MAX_VALUE_DECIMAL_PLACES;
  return Math.round(value * factor) / factor;
}

/**
 * The canonical decimal string to store, for a draft that has passed
 * `checkEntry`.
 *
 * Kept separate from `toCanonicalMl` because the two have different
 * obligations: that one feeds a validator that must see bad input as bad,
 * this one only ever runs on input already known to be good, and its output
 * goes into a `DECIMAL(12,4)` column whose value is permanent.
 *
 * A metric entry keeps its typed text verbatim — ADR-0005: stored values keep
 * their entered precision, and re-serialising through `Number` would turn
 * `"350.50"` into `"350.5"`. An imperial entry has to be converted, and
 * therefore cannot preserve what was typed; that is the conversion ADR-0005
 * governs, and the stored canonical value is the converted one.
 */
export function toCanonicalValueString(
  amountText: string,
  system: MeasurementSystem,
): string | undefined {
  const trimmed = amountText.trim();
  const parsed = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(parsed)) return undefined;

  // Same scale step as `toCanonicalMl`, and it MUST be the same: the value
  // validated and the value stored have to be identical, or Tier 1 passes a
  // number the database then refuses.
  return system === 'metric' ? trimmed : String(toStorableScale(ozToMl(parsed)));
}

/**
 * Decodes a STORED `method` back into the toggle's two answers, for a screen
 * that has to re-open a saved entry for editing.
 *
 * The inverse of `offlineWrites.ts`'s `resolveMethod`, and it reads the same
 * `@ostomy/core/validation` constants rather than comparing against literal
 * SNOMED strings — ADR-0018 records that changing either code is a data
 * migration, and a literal here would be a second place that migration has to
 * find.
 *
 * `null` in, `undefined` out: since ADR-0018's amendment, `method: null` at
 * rest means exactly "this observation has no toggle" (weight, resting heart
 * rate, or a colour-only urine entry), so there is no answer to restore. An
 * unrecognised code also yields `undefined` — a row written by a build that
 * used a different qualifier must not be silently relabelled as the other
 * answer, which is a clinical claim about how a number was arrived at.
 */
export function methodFromStoredCode(method: string | null): MeasuredOrEstimated | undefined {
  if (method === null) return undefined;
  if (MEASURED_METHOD_CODE.resolved && method === MEASURED_METHOD_CODE.code) return 'measured';
  if (ESTIMATION_METHOD_CODE.resolved && method === ESTIMATION_METHOD_CODE.code) return 'estimated';
  return undefined;
}

/**
 * Rule codes that belong beside the Measured/Estimated control rather than
 * beside the amount field.
 *
 * **Every Tier 1 error carries the SAME `field`** — `evaluateTier1` reports
 * `input.field` on all of them, `METHOD_REQUIRED` included — so a screen that
 * routes messages by `field` would put "Tell us if you measured this amount
 * or estimated it" under the amount box, next to a number that is perfectly
 * fine. Routing is therefore by rule code, and this constant is the split.
 */
// `METHOD_NOT_APPLICABLE` is the volume-less mirror of `METHOD_REQUIRED`
// (P3.S2) and belongs in the same place on screen: it says the toggle should
// not have been answered, so putting it under the amount field would point a
// patient at a box they left deliberately blank.
const METHOD_RULE_CODES: ReadonlySet<string> = new Set([
  'METHOD_REQUIRED',
  'METHOD_NOT_APPLICABLE',
]);

/** The Tier 1 error to show beside the Measured/Estimated control, if any. */
export function methodError(errors: readonly ValidationError[]): ValidationError | undefined {
  return errors.find((error) => METHOD_RULE_CODES.has(error.ruleCode));
}

/**
 * The Tier 1 error to show beside the amount field, if any.
 *
 * Reports the first non-method error rather than collecting them all: the
 * field can show one message, and `evaluateTier1` already returns them in a
 * fixed order so two devices walk a patient through the same sequence of
 * corrections (docs/sync-contract.md §6.3 requires the same of the server).
 */
export function amountError(errors: readonly ValidationError[]): ValidationError | undefined {
  return errors.find((error) => !METHOD_RULE_CODES.has(error.ruleCode));
}
