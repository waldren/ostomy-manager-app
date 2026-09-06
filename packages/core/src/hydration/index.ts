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
 */

export {
  BODY_WEIGHT_LOINC_CODE,
  FLUID_INTAKE_LOINC_CODE,
  RESTING_HEART_RATE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
} from './loincCodes.js';

export {
  countsTowardDailyNetFluidBalance,
  DAILY_NET_FLUID_BALANCE_LOINC_CODES,
  EXCLUDED_FROM_DAILY_NET_FLUID_BALANCE_LOINC_CODES,
  sumDailyNetFluidBalanceMl,
  type FluidBalanceObservation,
} from './netFluidBalance.js';
