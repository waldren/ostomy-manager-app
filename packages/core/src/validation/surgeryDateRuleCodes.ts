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
 * The rule codes a refused **surgery date** carries (SRS §3.0, P4.S1).
 *
 * ## Why these are shared rather than declared twice
 *
 * The surgery date is asked once, on the mobile onboarding screen, and
 * enforced by `POST /api/v1/onboarding`. Two parties therefore name the same
 * three problems: the screen, giving the patient an answer before a round trip,
 * and the API, which is the only enforcer that counts (CLAUDE.md: client-side
 * validation "is a UX affordance only"). A second copy of the vocabulary is how
 * a server refusal arrives with a code the screen has no copy for, and renders
 * as a generic "something went wrong" on the one field the patient could fix.
 *
 * ## What is NOT here, and why
 *
 * The **bound itself**. `MAX_SURGERY_DATE_AGE_YEARS` lives in
 * `apps/api/src/onboarding/onboarding-wire.ts`, server-side only, because the
 * server is what enforces it: the client never needs the number, only the copy
 * for the code that comes back. That also keeps this directory free of a
 * numeric literal `no-hardcoded-thresholds.spec.ts` would be right to question
 * — a plausibility bound on a profile field is not an injected clinical
 * threshold, and pretending either way would misrepresent it.
 *
 * And these are deliberately NOT members of `TIER1_RULE_CODE`. That set is the
 * rules an *entry* is checked against, and `i18n/catalog.spec.ts` asserts the
 * `validationErrors` namespace matches it exactly — a guarantee worth keeping
 * sharp. Onboarding copy lives under `common`'s `onboarding.*` keys instead.
 *
 * Lower-case, unlike `TIER1_RULE_CODE`, because these travel in the onboarding
 * 400's `fields[].rule` beside zod's own issue codes (`invalid_type`,
 * `unrecognized_keys`). One envelope, one spelling convention.
 */
export const SURGERY_DATE_RULE_CODE = {
  /**
   * The parts the patient typed do not name a real day — 31 February, or a
   * month of 13.
   *
   * Client-side only in practice: the wire carries one `YYYY-MM-DD` string and
   * zod's `z.iso.date()` refuses a malformed one under its own code, so the API
   * never emits this. It exists because the screen asks for day, month and year
   * separately, and that assembly step has no wire equivalent.
   */
  NOT_A_DATE: 'not_a_date',
  /**
   * A surgery that has not happened yet.
   *
   * Not a formality: this date becomes the Tier 1 lower timestamp bound
   * (`EFFECTIVE_DATE_TIME_BEFORE_SURGERY`), so a future one makes every entry
   * the patient could make fail — the app would accept their setup and then
   * refuse the first thing they logged, citing a date chosen on a screen they
   * have already left.
   */
  IN_THE_FUTURE: 'in_the_future',
  /**
   * A slipped century. `1025-03-04` passes every shape rule and silently
   * disables that same bound for the life of the account, with nothing
   * downstream reporting a rule that never fires.
   */
  IMPLAUSIBLY_OLD: 'implausibly_old',
} as const;

export type SurgeryDateRuleCode =
  (typeof SURGERY_DATE_RULE_CODE)[keyof typeof SURGERY_DATE_RULE_CODE];
