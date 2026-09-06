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
 * "common" namespace: copy shared across screens that is neither a
 * validation error, a validation warning, nor the heart-rate red-flag
 * prompt. See ../../index.ts for why those are kept in separate
 * namespaces.
 *
 * Unit wording is deliberately NOT duplicated here (S2, this sprint's
 * review): `../../format.ts`'s `formatVolumeQuantity` /
 * `formatWeightQuantity` source unit wording from
 * `Intl.NumberFormat`'s `style: 'unit'`, which is locale-aware and
 * CLDR-correct. A hand-written `unit.mL: 'milliliters (mL)'` string here
 * would be a second, unreferenced source of truth for the same wording —
 * the exact divergence ADR-0006 exists to prevent — so it was removed
 * rather than kept unused.
 */
export const common = {
  'method.measured': 'Measured',
  'method.estimated': 'Estimated',
} as const;
