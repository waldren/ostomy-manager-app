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
 * Reserved namespace for the heart-rate red-flag prompt (SRS §3.13, AC
 * 18.3 AC3 — not built until P7). Declared now, empty, so the structural
 * separation ADR-0006 requires — "a red-flag string can never be confused
 * with a Tier 2 warning" — exists from the first sprint that ships a
 * catalog, rather than being retrofitted once red-flag copy is written.
 *
 * Do not add validation copy here: this namespace is reserved for the
 * safety-response prompt, which CLAUDE.md requires never be routed
 * through the validation path. Do not populate it with placeholder or
 * invented copy either — the red-flag voice is a patient-safety property
 * and P7.S3's `accessibility-copy-reviewer` review of it is blocking.
 *
 * S7 (this sprint's review): namespace separation here stops a red-flag
 * STRING from being filed as a warning, but it does not by itself stop a
 * future author from adding a `redFlag` field to
 * `VolumetricValidationResult` (`packages/core/src/validation/types.ts`)
 * — at which point a client would pick the namespace from whatever the API
 * handed it, defeating this separation at the call site. The rule that
 * closes that gap: a red flag is NOT a third validation tier, and a red
 * flag never travels in the same result object as `errors` or `warnings`.
 * It is a distinct safety-response channel with its own type, evaluated
 * and surfaced independently of `VolumetricValidationResult` — see
 * CLAUDE.md's "heart-rate red-flag threshold is a safety response, not
 * validation" rule.
 */
export const redFlags = {} as const;
