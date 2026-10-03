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
 * The LOINC codes this client writes, in one place.
 *
 * ## Why these are copied here rather than imported from `packages/core`
 *
 * `packages/core/src/hydration/loincCodes.ts` holds the same literals and
 * **deliberately does not export them**. Its own comment is the reason:
 * exporting them "would make this module a de facto terminology entry point
 * and raise the cost of the eventual move to `packages/core/src/fhir`
 * (ADR-0007) — consumers get behaviour and named sets, never the raw codes."
 * That decision stands, so this module is the app-side copy rather than a
 * route around it.
 *
 * What it replaces is three copies: `useStomaOutputEntry.ts` exported one,
 * and `add-intake.tsx` and `add-urine.tsx` each declared their own local
 * const. P3.S4 needs all three codes together — Quick-Add generates over the
 * patient's volumetric history regardless of which screen made it — and three
 * literals in three files is the shape that lets two of them disagree.
 *
 * When `packages/core/src/fhir` lands it becomes the terminology authority and
 * this module should import from it. That is the move `loincCodes.ts` is
 * holding the door open for; until then, these five literals existing twice in
 * the repo is a known and recorded duplication, not an oversight.
 */

/** Stoma output volume. */
export const STOMA_OUTPUT_LOINC_CODE = '79560-9';

/** Oral fluid intake volume. */
export const FLUID_INTAKE_LOINC_CODE = '9000-1';

/** Voided urine — the one code that may carry a colour and no volume (AC 12.1 AC2). */
export const VOIDED_URINE_LOINC_CODE = '9187-6';
