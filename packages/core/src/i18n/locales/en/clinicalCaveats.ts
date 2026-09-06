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
 * Reserved namespace for clinical caveat copy — statements that qualify
 * how a signal should be read, rather than validating an entry or
 * escalating a red flag. SRS §3.13 requires the beta-blocker caveat
 * ("rate-controlling medications can mask tachycardia") to appear in BOTH
 * the patient-facing and physician-facing resting-heart-rate views: one
 * clinical statement, two audiences, two clients (`apps/web` and the
 * physician view), which makes it the single highest-drift-risk string in
 * the product if it is written twice independently instead of sourced from
 * one place.
 *
 * Declared now, empty, for the same reason as `./redFlags.ts`: the
 * structural separation exists from the first sprint that ships a catalog,
 * rather than being retrofitted once the copy is written in P7. A
 * clinical caveat is also its own tone — a qualification the reader should
 * keep in mind, not an error, not a soft warning about data plausibility,
 * and not the heart-rate red-flag safety response — so it does not belong
 * in `validationErrors`, `validationWarnings`, or `redFlags` either.
 *
 * Do not add caveat copy here yet. No clinical statement is invented in
 * this file; SRS §3.13's exact wording, once drafted, is the only source.
 */
export const clinicalCaveats = {} as const;
