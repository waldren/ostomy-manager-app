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
 * TODO(code-unverified): deliberately `null`, not a guessed string. "A
 * wrong SNOMED code is a silent, durable data-quality defect that only
 * surfaces at FHIR export or EHR integration" (v1-implementation-plan.md
 * D4) — i.e., after many rows already carry it. When D4 resolves, this is
 * the one place to change, plus a data migration over any
 * `observations.method` rows written while this was `null`. Record the
 * resolution in design-specs/data-model/fhir-rxnorm-integration.md and
 * write an ADR.
 */
export const ESTIMATION_METHOD_CODE: string | null = null;
