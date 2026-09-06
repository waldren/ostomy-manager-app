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
 * SNOMED CT "Estimation technique" code, populated on FHIR
 * `Observation.method` when a volumetric entry is marked Estimated (SRS AC
 * 2.5 AC2; CLAUDE.md "Data model rules that are easy to get wrong"). Lives
 * beside the Measured/Estimated Tier 1 rule (`./tier1.js`'s
 * `METHOD_REQUIRED`) that makes the toggle mandatory in the first place,
 * rather than in `../i18n`, since this is a terminology code, not
 * translatable copy.
 *
 * This is decision D4 in
 * design-specs/planning/v1-implementation-plan.md, and it is still open:
 * an external terminology lookup, not an engineering decision. Do NOT
 * invent a code here.
 *
 * Modelled as a discriminated union, not `string | null` (B4, this
 * sprint's review): Prisma's `observations.method` column is `String?`,
 * which happily accepts `null` — so `method: ESTIMATION_METHOD_CODE`
 * typechecked when this was `string | null`, and an ESTIMATED entry would
 * have persisted with `method: null`, indistinguishable from a MEASURED
 * entry, since `method` is the only stored representation of the
 * Measured/Estimated flag. That makes AC 2.2 AC2 (history badges every
 * entry Estimated or Measured) unsatisfiable for every row written while
 * the code was unresolved, with no separate source of truth to migrate
 * from later.
 *
 * `{ resolved: false }` has no `code` property at all, so a call site that
 * writes `method: ESTIMATION_METHOD_CODE.code` without first narrowing on
 * `resolved` is a compile error, not a silent `null` write. A caller MUST
 * branch on `resolved` and refuse to persist an Estimated entry (queue it,
 * error, or block — a P1.S5/mobile-sync decision, not this module's) until
 * this resolves to `{ resolved: true, code: '<snomed-code>' }`.
 *
 * TODO(code-unverified): deliberately unresolved, not a guessed string. "A
 * wrong SNOMED code is a silent, durable data-quality defect that only
 * surfaces at FHIR export or EHR integration" (v1-implementation-plan.md
 * D4) — i.e., after many rows already carry it. When D4 resolves, this is
 * the one place to change, plus a data migration over any
 * `observations.method` rows written while this was unresolved. Record the
 * resolution in design-specs/data-model/fhir-rxnorm-integration.md and
 * write an ADR.
 */
export type EstimationMethodCode =
  { readonly resolved: true; readonly code: string } | { readonly resolved: false };

export const ESTIMATION_METHOD_CODE: EstimationMethodCode = { resolved: false };
