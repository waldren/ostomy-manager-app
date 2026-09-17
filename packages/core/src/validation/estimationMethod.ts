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
 * This was decision D4 in
 * design-specs/planning/v1-implementation-plan.md, and it is **RESOLVED**:
 * SNOMED CT `414135002` |Estimated (qualifier value)|, recorded in
 * design-specs/data-model/fhir-rxnorm-integration.md and ADR-0018.
 *
 * `null` still means measured on the wire and in storage
 * (docs/sync-contract.md §7.2). SNOMED CT `258104002` |Measured (qualifier
 * value)| exists and is the paired concept, but adopting it would change
 * what `method: null` means and is a separate decision — see ADR-0018's
 * "What this does not change".
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
 * The union stays a union now that it is resolved. It is what makes the
 * unresolved state unrepresentable at a call site rather than merely
 * unlikely, and the shape is what the next unresolved terminology code
 * (voided-urine colour, resting-conditions flag) should copy.
 *
 * **Changing the code here is a data migration, not an edit.** Any
 * `observations.method` row already carrying the old value would keep it,
 * silently, and the disagreement surfaces only at FHIR export or EHR
 * integration — after many rows carry it (v1-implementation-plan.md D4).
 */
export type EstimationMethodCode =
  { readonly resolved: true; readonly code: string } | { readonly resolved: false };

/**
 * SNOMED CT `414135002` |Estimated (qualifier value)|.
 *
 * A qualifier value rather than a procedure/technique concept, which is
 * worth noting because the SRS and this file both say "Estimation
 * technique": FHIR `Observation.method` is a `CodeableConcept` with no
 * value-set binding that would forbid a qualifier, and what this field
 * records is *how the number was arrived at*, which is what the qualifier
 * says. The wording elsewhere is the informal name of the decision, not a
 * constraint on the concept chosen.
 */
export const ESTIMATION_METHOD_CODE: EstimationMethodCode = {
  resolved: true,
  code: '414135002',
};
