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

import { common } from './locales/en/common.js';
import { redFlags } from './locales/en/redFlags.js';
import { validationErrors } from './locales/en/validationErrors.js';
import { validationWarnings } from './locales/en/validationWarnings.js';
import { DEFAULT_LOCALE } from './constants.js';

/**
 * Catalog namespaces (ADR-0006). Four separate namespaces, not adjacent
 * keys within one, because two distinctions must be legible to a reviewer
 * reading the catalog's structure alone:
 *
 *   - `validationErrors` (Tier 1, blocks the save) vs. `validationWarnings`
 *     (Tier 2, saves normally and asks for confirmation) — different
 *     severities, never comparable by a severity field someone could
 *     misread.
 *   - `validationWarnings` vs. `redFlags` (the heart-rate safety response,
 *     P7) — a data-quality nudge vs. "seek care," which must never share
 *     a voice or a code path (CLAUDE.md).
 */
export const NAMESPACES = ['common', 'validationErrors', 'validationWarnings', 'redFlags'] as const;
export type Namespace = (typeof NAMESPACES)[number];

export const en = {
  common,
  validationErrors,
  validationWarnings,
  redFlags,
} satisfies Record<Namespace, Record<string, string>>;

/**
 * i18next resource-bundle shape (`{ [locale]: { [namespace]: {...} } }`),
 * ready for `i18next.init({ resources })` on either client (ADR-0006). v1
 * ships English-only; the shape is multi-locale-ready.
 */
export const resources = { [DEFAULT_LOCALE]: en } as const;

export { DEFAULT_LOCALE };
export {
  formatDateTime,
  formatNumber,
  formatVolumeQuantity,
  formatWeightQuantity,
} from './format.js';
