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
 * Page-level tests for the physician view.
 *
 * Code review found that every module in this sprint with real branching —
 * the auth provider, this page, the API client factory — had no test at all,
 * and that every defect it reported lived in that untested layer. This file
 * covers the one with clinical consequences: which day's data is shown under
 * which day's heading.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, type Observation } from '@ostomy/core/api-client';

import { PhysicianOutputView } from './PhysicianOutputView.js';
import '../i18n/index.js';

const listMock = vi.fn();

vi.mock('../api/client.js', () => ({
  createWebApiClient: () => ({ observations: { list: listMock } }),
}));

// One stable object, not a fresh one per render. `PhysicianOutputView`
// memoizes its API client on `getAccessToken`'s identity, so a mock that
// returns a new function each call makes the load effect re-run on every
// render — which is the separate defect code review raised about the real
// `getAccessToken` (its identity changes on every token refresh). Keeping
// the mock stable is what lets this file test request ordering rather than
// that.
const authValue = {
  status: 'authenticated' as const,
  error: undefined,
  signIn: vi.fn(),
  signOut: vi.fn(),
  getAccessToken: vi.fn().mockResolvedValue('token'),
};

vi.mock('../auth/AuthContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/AuthContext.js')>()),
  useAuth: () => authValue,
}));

function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    resourceType: 'Observation',
    id: '11111111-1111-4111-8111-111111111111',
    status: 'final',
    code: '79560-9',
    valueQuantity: { value: 100, unit: 'mL' },
    effectiveDateTime: '2026-09-07T02:00:00.000Z',
    method: null,
    enteredMeasurementSystem: 'metric',
    ...overrides,
  } as Observation;
}

/** A promise plus the handles to settle it, so a test controls arrival order. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  listMock.mockReset();
  authValue.signOut.mockReset();
});

describe('PhysicianOutputView — request ordering', () => {
  it('never shows a superseded day’s data, even when its response lands last', async () => {
    // The defect this exists for: without a staleness guard, responses are
    // applied in ARRIVAL order while the date control shows what the user
    // chose — so a clinician reads one day's volumes and total under another
    // day's heading. Reachable by ordinary use on a slow LAN.
    const first = deferred<{ observations: Observation[] }>();
    const second = deferred<{ observations: Observation[] }>();
    listMock.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    render(<PhysicianOutputView />);

    // Navigate to a different day, so a second request is in flight.
    await userEvent.click(screen.getByRole('button', { name: /previous day/i }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));

    // The SECOND request answers first, then the superseded first request
    // lands — the out-of-order arrival that produced the bug.
    second.resolve({ observations: [observation({ valueQuantity: { value: 222, unit: 'mL' } })] });
    // Plural: the value legitimately appears in the table, the chart's
    // visually-hidden list, and the daily total.
    await screen.findAllByText(/222/);

    first.resolve({ observations: [observation({ valueQuantity: { value: 999, unit: 'mL' } })] });

    // The stale value must never appear. `findByText` would pass on a
    // transient render, so assert its continued absence after a flush.
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
    expect(screen.queryAllByText(/999/)).toHaveLength(0);
    expect(screen.queryAllByText(/222/).length).toBeGreaterThan(0);
  });
});

describe('PhysicianOutputView — a day bigger than one page', () => {
  /**
   * The defect this exists for: the request sent no `limit`, so the server
   * applied its default of 100. A high-output ileostomy day can exceed that,
   * and the truncation was invisible — the chart and table just ended, and
   * the DAILY TOTAL was summed over the truncated set and presented as the
   * day's total. A physician assessing hydration reads a confidently-wrong
   * number, low by however much was cut, with nothing on screen saying so.
   */
  it('asks for the full page size rather than taking the server default', async () => {
    listMock.mockResolvedValue({ observations: [observation()] });

    render(<PhysicianOutputView />);

    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));
    // The assertion is on the limit being SENT. Without it the server's
    // default silently governs, and no assertion about rendering can see
    // the difference until a day happens to exceed 100 entries.
    expect(listMock.mock.calls[0]?.[0]).toMatchObject({ limit: 500 });
  });

  it('warns that the total is incomplete when the response fills the page', async () => {
    const full = Array.from({ length: 500 }, (_, index) =>
      observation({ id: `11111111-1111-4111-8111-${String(index).padStart(12, '0')}` }),
    );
    listMock.mockResolvedValue({ observations: full });

    render(<PhysicianOutputView />);

    expect(await screen.findByText(/more entries than are shown/i)).toBeVisible();
    expect(screen.getByText(/may be lower than the true total/i)).toBeVisible();
    // Names the end of the day that was actually cut. `observations.service.ts`
    // orders `effectiveDatetime: 'desc'` and takes the limit, so a truncated
    // day returns the MOST RECENT entries and drops the earliest — the copy
    // said "only the first entries were loaded", which is the opposite, and
    // would send a physician looking for a gap in the evening.
    expect(screen.getByText(/most recent entries/i)).toBeVisible();
    expect(screen.getByText(/earliest ones are not shown/i)).toBeVisible();
    // The real page size, not a vague "the first entries". Scoped to the
    // notice: the load-complete status region also says "500 entries
    // loaded", so a document-wide match would pass on that instead.
    expect(screen.getByText(/most recent entries/i).textContent).toContain('500');
  });

  it('does not warn on an ordinary day, so the warning keeps its meaning', async () => {
    listMock.mockResolvedValue({ observations: [observation(), observation({ id: 'b' })] });

    render(<PhysicianOutputView />);

    // Wait for the load to settle before asserting an absence, or this
    // passes against the loading state and proves nothing.
    await screen.findByRole('heading', { name: /output entries|entries/i });
    expect(screen.queryByText(/more entries than are shown/i)).not.toBeInTheDocument();
  });
});

describe('PhysicianOutputView — keyboard order', () => {
  /**
   * Sign-out was the first control inside `<main>`, so every keyboard and
   * screen-reader user who followed the skip link — the users the skip link
   * exists for — arrived one Tab press from ending their session, before
   * reaching any of the day's data.
   */
  it('does not put sign-out inside the main landmark', async () => {
    listMock.mockResolvedValue({ observations: [] });
    render(<PhysicianOutputView />);

    const main = await screen.findByRole('main');
    expect(within(main).queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('puts the first main-region control on the day being viewed, not on leaving', async () => {
    // Tab order follows the DOM, so asserting on document order is
    // asserting on tab order. The first control a user reaches inside the
    // content region should act on the content.
    listMock.mockResolvedValue({ observations: [] });
    render(<PhysicianOutputView />);

    const main = await screen.findByRole('main');
    const firstControl = within(main).getAllByRole('button')[0];
    expect(firstControl).toHaveAccessibleName(/previous day/i);
  });

  it('keeps sign-out reachable, in the banner', async () => {
    // Moving it must not lose it: the control still has to exist, and after
    // the RP-initiated-logout work it is the only way to end a session
    // deliberately.
    listMock.mockResolvedValue({ observations: [] });
    render(<PhysicianOutputView />);

    const banner = await screen.findByRole('banner');
    expect(within(banner).getByRole('button', { name: /sign out/i })).toBeVisible();
  });
});

describe('PhysicianOutputView — announcements and unrecoverable states', () => {
  it('announces that a day finished loading, not only that it started (WCAG 4.1.3)', async () => {
    // The loading paragraph was conditionally mounted, so the region was
    // REMOVED when the data arrived and nothing announced the result. A
    // screen-reader user pressed previous-day, heard "Loading…", then
    // silence — with no way to tell whether the rows under their cursor
    // belonged to the day now shown in the date control.
    listMock.mockResolvedValue({ observations: [observation()] });
    render(<PhysicianOutputView />);

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/1 entry loaded for/i),
    );
  });

  it('pluralises the count rather than saying "1 entries"', async () => {
    listMock.mockResolvedValue({
      observations: [observation(), observation({ id: 'b' })],
    });
    render(<PhysicianOutputView />);

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(/2 entries loaded for/i),
    );
  });

  it('signs out on a 401 instead of offering a retry that cannot succeed', async () => {
    // `getAccessToken` still sees a locally-unexpired token, so it hands the
    // same rejected one back every time: the "Try again" button could be
    // pressed forever. Reachable on a revoked session, clock skew past the
    // 30s margin, or an audience mismatch.
    listMock.mockRejectedValue(new ApiError(401, { error: { code: 'UNAUTHENTICATED' } }));
    render(<PhysicianOutputView />);

    await waitFor(() => expect(authValue.signOut).toHaveBeenCalledWith('session_expired'));
    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument();
  });

  it('still offers a retry for an error that retrying can fix', async () => {
    // A transient network failure is the case the retry button is for;
    // collapsing every error into a sign-out would be the opposite defect.
    listMock.mockRejectedValue(new Error('network down'));
    render(<PhysicianOutputView />);

    expect(await screen.findByRole('button', { name: /try again/i })).toBeVisible();
    expect(authValue.signOut).not.toHaveBeenCalled();
  });
});
