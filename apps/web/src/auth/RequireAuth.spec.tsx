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

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { AuthContextValue, AuthStatus } from './AuthContext.js';
import { RequireAuth } from './RequireAuth.js';
import '../i18n/index.js';

const authValue = {
  status: 'initializing' as AuthStatus,
  error: undefined,
  signIn: vi.fn(),
  signOut: vi.fn(),
  getAccessToken: vi.fn(),
} satisfies AuthContextValue;

vi.mock('./AuthContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./AuthContext.js')>()),
  useAuth: () => authValue,
}));

function renderGuarded() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <RequireAuth>
              <main id="main-content">
                <h1>Physician view</h1>
              </main>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<h1>Sign in</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('RequireAuth', () => {
  it('redirects an unauthenticated visitor to the login route', () => {
    authValue.status = 'unauthenticated';
    renderGuarded();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('renders the guarded content once authenticated', () => {
    authValue.status = 'authenticated';
    renderGuarded();
    expect(screen.getByRole('heading', { name: 'Physician view' })).toBeInTheDocument();
  });

  describe('while the session is being restored', () => {
    /**
     * Session restore is not an edge case — it is every returning visit, and
     * `App` renders the skip link unconditionally. The initializing state
     * used to be a bare `<p>`, so for the duration of every restore the
     * first tab stop was "Skip to main content" pointing at a target that
     * did not exist (WCAG 2.4.1), on a page with no landmark (1.3.1) and no
     * heading (2.4.6).
     */
    it('provides the landmark the skip link targets', () => {
      authValue.status = 'initializing';
      renderGuarded();
      const main = screen.getByRole('main');
      expect(main).toHaveAttribute('id', 'main-content');
      // Safari/VoiceOver does not move the reading cursor on fragment
      // navigation without this, and that pairing is disproportionately
      // common in this population.
      expect(main).toHaveAttribute('tabindex', '-1');
    });

    it('provides a heading, so the page is not anonymous to a screen reader', () => {
      authValue.status = 'initializing';
      renderGuarded();
      expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
    });

    it('announces the wait politely rather than silently', () => {
      authValue.status = 'initializing';
      renderGuarded();
      const status = screen.getByRole('status');
      expect(status).toBeVisible();
      expect(status).toHaveAttribute('aria-live', 'polite');
    });

    it('does not render the guarded content before the session is known', () => {
      // The substantive guarantee: a guarded page must never flash its
      // content while auth is still undetermined.
      authValue.status = 'initializing';
      renderGuarded();
      expect(screen.queryByRole('heading', { name: 'Physician view' })).not.toBeInTheDocument();
    });
  });
});
