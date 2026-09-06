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
 * Tier 2 (soft, always-overridable) copy — SRS §3.8. Separate from
 * `validationErrors` and `redFlags` for the same reason: tone. A Tier 2
 * warning states plainly what looks unusual and asks the patient to
 * confirm; it never blocks the save and never scolds (CLAUDE.md;
 * ADR-0006's compliance review). Keyed by `ValidationWarning.ruleCode`.
 */
export const validationWarnings = {
  // SRS AC 2.1 AC2's exact approved copy (v2.5 — corrected during P1.S4
  // review; see SRS_v2.md's "v2.5 correction" note). An approved
  // acceptance criterion's prompt text is not a suggestion to be
  // paraphrased: this is the verbatim string. It states plainly that the
  // entry is welcome, never conditions saving on the amount being
  // "correct," and never scolds — a genuine high-volume day "is precisely
  // the data point the care team most needs to see" (SRS §3.8).
  VALUE_ABOVE_TYPICAL_RANGE:
    'This amount is higher than most entries. If it is right, save it. Your care team needs to see days like this.',
} as const;
