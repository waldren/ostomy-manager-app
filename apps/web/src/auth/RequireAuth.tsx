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

import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate } from 'react-router-dom';

import { useAuth } from './AuthContext.js';

/** Gates a route on an authenticated patient session; otherwise redirects to `/login`. */
export function RequireAuth({ children }: { readonly children: ReactNode }) {
  const { status } = useAuth();
  const { t } = useTranslation();

  if (status === 'initializing') {
    // A real `<main id="main-content">` with an `<h1>`, not a bare `<p>`.
    //
    // `App` renders the skip link unconditionally, so during every session
    // restore the first tab stop was "Skip to main content" pointing at a
    // target that did not exist (WCAG 2.4.1), on a page with no landmark and
    // no heading (1.3.1, 2.4.6). Session restore is not an edge case — it is
    // every returning visit.
    //
    // `tabIndex={-1}` because Safari/VoiceOver does not move the reading
    // cursor on fragment navigation without it, and that combination is
    // disproportionately common in this population.
    return (
      <main id="main-content" tabIndex={-1}>
        <h1>{t('auth.restoringSessionHeading')}</h1>
        <p role="status" aria-live="polite">
          {t('auth.restoringSession')}
        </p>
      </main>
    );
  }

  if (status === 'unauthenticated') {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}
