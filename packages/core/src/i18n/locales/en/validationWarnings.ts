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
  // SRS AC 2.1 AC2's suggested copy ("This is a high volume for a single
  // entry. Please confirm this amount is correct"), rendered to invite a
  // check rather than issue an instruction — the entry saves either way.
  VALUE_ABOVE_TYPICAL_RANGE:
    'This is a high volume for a single entry. Check the number, then save it if it is correct.',
} as const;
