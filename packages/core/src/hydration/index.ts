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
 * Only what P2 needs (this sprint's scope): the classification of which
 * LOINC codes count toward Daily Net Fluid Balance, with voided urine
 * excluded on purpose. The composite hydration status (P6/P7) is
 * deliberately not built here.
 *
 * `./loincCodes.js` is intentionally NOT re-exported here. Its literals are
 * module-internal to this classification; exporting them would make this
 * module a de facto terminology entry point and raise the cost of the
 * eventual move to `packages/core/src/fhir` (ADR-0007). Consumers get
 * behaviour (`countsTowardDailyNetFluidBalance`, `netDailyFluidBalanceMl`)
 * and named sets, never the raw codes.
 */

export {
  countsTowardDailyNetFluidBalance,
  DAILY_NET_FLUID_BALANCE_LOINC_CODES,
  EXCLUDED_FROM_DAILY_NET_FLUID_BALANCE_LOINC_CODES,
  NET_FLUID_BALANCE_INTAKE_LOINC_CODES,
  NET_FLUID_BALANCE_OUTPUT_LOINC_CODES,
  netDailyFluidBalanceMl,
  isUrineOutputSignal,
  URINE_OUTPUT_LOINC_CODES,
  type FluidBalanceObservation,
} from './netFluidBalance.js';
