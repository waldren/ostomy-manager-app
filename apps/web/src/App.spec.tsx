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

import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppRoutes } from './App.js';
import './i18n/index.js';

vi.mock('./auth/AuthContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth/AuthContext.js')>()),
  useAuth: () => ({
    status: 'unauthenticated' as const,
    error: undefined,
    signIn: vi.fn(),
    signOut: vi.fn(),
    getAccessToken: vi.fn(),
  }),
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppRoutes />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  document.title = '';
});

describe('per-route document titles (WCAG 2.4.2)', () => {
  /**
   * It was one constant title for every route. Beyond 2.4.2's requirement
   * that a title describe topic or purpose, in a single-page app the title
   * change is also how a screen-reader user learns a route change happened
   * at all — nothing else here announces one, so a guarded redirect to the
   * login page was silent.
   */
  it('titles the login route', async () => {
    renderAt('/login');
    await waitFor(() => expect(document.title).toMatch(/Sign in/i));
  });

  it('titles an unmatched route rather than leaving the previous one', async () => {
    // The stale-title case is the one that misleads: landing on a dead link
    // while the tab still claims to be the physician view.
    renderAt('/no-such-page');
    await waitFor(() => expect(document.title).toMatch(/not found/i));
  });

  it('includes the product name, so a tab is identifiable among many', async () => {
    renderAt('/login');
    await waitFor(() => expect(document.title).toMatch(/Ostomy Care/i));
  });
});

describe('routing', () => {
  it('renders the not-found page for an unmatched path', () => {
    renderAt('/no-such-page');
    expect(screen.getByRole('heading', { level: 1 })).toBeVisible();
  });

  it('sends an unauthenticated visitor from the guarded root to the login page', () => {
    renderAt('/');
    expect(screen.getByRole('button', { name: /sign in/i })).toBeVisible();
  });
});

describe('the skip link', () => {
  it('is rendered and points at the main landmark', () => {
    // Every page this app renders — including the loading and login states —
    // provides `#main-content`, which is what makes the link honest.
    renderAt('/login');
    const skip = screen.getByRole('link', { name: /skip to main content/i });
    expect(skip).toHaveAttribute('href', '#main-content');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });
});
