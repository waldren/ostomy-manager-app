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

import { DEFAULT_LOCALE, en, resources } from '@ostomy/core/i18n';

/**
 * Every namespace comes from the shared catalog (ADR-0006: one catalog, no
 * per-app catalogs). This app's own shell copy is the `web` namespace
 * *inside* that catalog — see `packages/core/src/i18n/locales/en/web.ts`.
 *
 * Nothing is merged in here on purpose: the moment this file composes a
 * local resource bundle, there are two catalogs again regardless of where
 * the files sit.
 */
void i18next.use(initReactI18next).init({
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: 'web',
  ns: Object.keys(en),
  resources,
  interpolation: {
    // React already escapes rendered output.
    escapeValue: false,
  },
  returnNull: false,
});

export default i18next;
