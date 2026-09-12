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

import { SkipLink } from '@ostomy/ui';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';

import { AuthProvider } from './auth/AuthContext.js';
import { RequireAuth } from './auth/RequireAuth.js';
import { LoginPage } from './pages/LoginPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { PhysicianOutputView } from './pages/PhysicianOutputView.js';

/**
 * Sets a per-route document title.
 *
 * It was one constant title for every route. WCAG 2.4.2 (Level A) requires a
 * title describing topic or purpose, and in an SPA the title change is also
 * how a screen-reader user learns a route change happened at all — nothing
 * else here announces one.
 *
 * Keyed off the same catalog entries the pages' own `<h1>`s use, so the two
 * cannot drift.
 */
const ROUTE_TITLE_KEYS: Record<string, string> = {
  '/': 'physicianView.heading',
  '/login': 'auth.signInHeading',
};

function DocumentTitle() {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  useEffect(() => {
    const key = ROUTE_TITLE_KEYS[pathname] ?? 'errors.notFoundHeading';
    document.title = t('app.documentTitle', { page: t(key) });
  }, [t, pathname]);

  return null;
}

/**
 * Everything inside the router, exported separately so tests can mount it
 * under a `MemoryRouter` at a chosen path.
 *
 * `App` used to be one component containing its own `BrowserRouter`, which
 * made routing, the per-route document title, and the skip link's target
 * unreachable from a test: mounting `App` gave whatever path jsdom happened
 * to be on, and a nested router is not a supported way to override it. The
 * split is the whole reason those three now have tests.
 */
export function AppRoutes() {
  const { t } = useTranslation();

  return (
    <>
      <DocumentTitle />
      <SkipLink targetId="main-content">{t('app.skipToMainContent')}</SkipLink>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <PhysicianOutputView />
            </RequireAuth>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
