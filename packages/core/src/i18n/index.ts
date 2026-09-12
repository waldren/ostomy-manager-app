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

import { web } from './locales/en/web.js';
import { clinicalCaveats } from './locales/en/clinicalCaveats.js';
import { common } from './locales/en/common.js';
import { redFlags } from './locales/en/redFlags.js';
import { validationErrors } from './locales/en/validationErrors.js';
import { validationWarnings } from './locales/en/validationWarnings.js';
import { DEFAULT_LOCALE } from './constants.js';

/**
 * Catalog namespaces (ADR-0006). Separate namespaces, not adjacent keys
 * within one, because these distinctions must be legible to a reviewer
 * reading the catalog's structure alone:
 *
 *   - `validationErrors` (Tier 1, blocks the save) vs. `validationWarnings`
 *     (Tier 2, saves normally and asks for confirmation) — different
 *     severities, never comparable by a severity field someone could
 *     misread.
 *   - `validationWarnings` vs. `redFlags` (the heart-rate safety response,
 *     P7) — a data-quality nudge vs. "seek care," which must never share
 *     a voice or a code path (CLAUDE.md; see `redFlags.ts`'s doc comment
 *     for the additional structural rule this implies for
 *     `VolumetricValidationResult`).
 *   - `redFlags` vs. `clinicalCaveats` — "seek care now" vs. a standing
 *     qualification on how to read a signal (e.g. the SRS §3.13
 *     beta-blocker caveat), neither of which is a validation message at
 *     all.
 *
 * Key-naming convention (S5, this sprint's review), for every namespace:
 *   - `*.label` — visible text.
 *   - `*.a11yLabel` — an accessible name ONLY when it must differ from the
 *     visible label (e.g. an icon-only control). It names the ACTION the
 *     control performs, never the icon ("Log stoma output", not
 *     "Droplet icon"). Never carry meaning by colour alone — a state that
 *     is colour-coded must also have a `*.label` or `*.a11yLabel` text
 *     equivalent (urine-colour scale steps, hydration statuses).
 *   - `*.hint` — supplementary text, not the accessible name itself.
 *
 * No catalog key contains a digit (see `catalog.spec.ts`) — ADR-0006:
 * values interpolate into rendered messages, identifiers never do.
 */
export const NAMESPACES = [
  'common',
  'validationErrors',
  'validationWarnings',
  'redFlags',
  'clinicalCaveats',
  'web',
] as const;
export type Namespace = (typeof NAMESPACES)[number];

export const en = {
  common,
  validationErrors,
  validationWarnings,
  redFlags,
  clinicalCaveats,
  web,
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
