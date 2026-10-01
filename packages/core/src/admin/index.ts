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
 * The subpath admin code is allowed to import (ADR-0007, ADR-0008).
 *
 * It exists because `packages/config/eslint/index.js`'s admin allow-list already
 * names `@ostomy/core/admin` and nothing had created it. That allow-list denies by
 * default on purpose — a deny-list "fails open, silently, every time someone adds a
 * subpath nobody remembers to enumerate" — so admin code cannot import
 * `@ostomy/core/validation`, and the first admin surface that needed a storage-shape
 * bound (P3.S3) had no legitimate way to get one.
 *
 * ## What may live here, and what may not
 *
 * Only facts about how values are STORED. No patient types, no clinical rules, no
 * thresholds. The test for whether something belongs is whether an admin console
 * with zero PHI access could hold it without that becoming untrue (SRS §3.11).
 *
 * Re-exported from `../validation/representableRange`, never redeclared. These are
 * the canonical `DECIMAL(12,4)` column's shape, and two copies of one number is the
 * drift this repo has already paid for in the write paths CLAUDE.md records.
 */
export {
  MAX_REPRESENTABLE_VALUE_ML,
  MAX_VALUE_DECIMAL_PLACES,
  decimalPlaces,
  exceedsMaxMagnitude,
  exceedsMaxPrecision,
} from '../validation/representableRange.js';
