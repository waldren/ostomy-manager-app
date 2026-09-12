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

import { DEFAULT_LOCALE, en, NAMESPACES } from '@ostomy/core/i18n';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import { mobile } from './localCatalog';

/**
 * `i18next` + `react-i18next` (ADR-0006), initialized once at app start
 * (`app/_layout.tsx` imports this module for its side effect). Every
 * shared namespace from `@ostomy/core/i18n` is registered so a future
 * screen's `useTranslation('validationErrors')` (etc.) works with no
 * further wiring — this sprint's screens only consume `mobile` and
 * `common`, but the sync worker's correction inbox (P2.S2b) will need
 * `validationErrors` immediately.
 *
 * `mobile` is this app's own stopgap namespace — see
 * `./localCatalog.ts`'s header comment for why it exists and why it
 * should not gain a sibling in `apps/web` or `apps/admin`.
 */
void i18next.use(initReactI18next).init({
  resources: {
    [DEFAULT_LOCALE]: { ...en, mobile },
  },
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  ns: [...NAMESPACES, 'mobile'],
  defaultNS: 'mobile',
  interpolation: {
    // React already escapes rendered text; double-escaping breaks any
    // future copy that legitimately contains an ampersand or apostrophe.
    escapeValue: false,
  },
  // No literal-string copy in this file — this is configuration, not UI.
  returnNull: false,
});

export default i18next;
