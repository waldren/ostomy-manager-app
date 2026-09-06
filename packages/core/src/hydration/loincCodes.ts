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
 * LOINC codes for the observation types this hydration classification
 * needs to distinguish. Cited as "verified" by
 * design-specs/data-model/p1-s3-schema-coverage.md's "Codes verified vs.
 * TODO" section and by CLAUDE.md.
 *
 * `packages/core/src/fhir` (not built yet — ADR-0007 assigns it to
 * `fhir-data-modeler`) will eventually own the full FHIR `Observation`
 * code/system mapping. This file defines only what
 * `packages/core/src/hydration` needs to classify an observation for
 * Daily Net Fluid Balance purposes, and should not be read as this
 * package's general terminology authority — see this sprint's report for
 * the flagged risk of two independent LOINC-code lists once `src/fhir`
 * exists, and the recommendation that it import from here (or this module
 * be consolidated into it) rather than duplicate the literals.
 */
export const STOMA_OUTPUT_LOINC_CODE = '79560-9';
export const FLUID_INTAKE_LOINC_CODE = '9000-1';
export const VOIDED_URINE_LOINC_CODE = '9187-6';
export const BODY_WEIGHT_LOINC_CODE = '29463-7';
export const RESTING_HEART_RATE_LOINC_CODE = '8867-4';
