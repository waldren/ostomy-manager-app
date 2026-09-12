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

import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import { DEFAULT_LOCALE, en } from '@ostomy/core/i18n';

import { web } from './locales/en/web.js';

/**
 * Merges the shared `@ostomy/core/i18n` catalog (common/validation/red-flag/
 * clinical-caveat namespaces, ADR-0006) with this app's own `web` namespace
 * — see `./locales/en/web.ts`'s doc comment for why that namespace exists
 * and is not yet folded into the shared catalog.
 */
void i18next.use(initReactI18next).init({
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: 'web',
  ns: [...Object.keys(en), 'web'],
  resources: {
    [DEFAULT_LOCALE]: {
      ...en,
      web,
    },
  },
  interpolation: {
    // React already escapes rendered output.
    escapeValue: false,
  },
  returnNull: false,
});

export default i18next;
