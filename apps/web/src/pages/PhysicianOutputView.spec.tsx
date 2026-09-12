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

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Observation } from '@ostomy/core/api-client';

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

  it('does not apply a response that arrives after unmount', async () => {
    // Every sign-out hits this path: signOut flips status, RequireAuth
    // navigates away, and the in-flight request still resolves.
    const inFlight = deferred<{ observations: Observation[] }>();
    listMock.mockReturnValueOnce(inFlight.promise);

    const { unmount } = render(<PhysicianOutputView />);
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(1));

    unmount();
    inFlight.resolve({ observations: [observation()] });

    // A state write after unmount surfaces as a React act/console error
    // rather than a thrown exception, so assert the console stayed clean.
    const errorSpy = vi.spyOn(console, 'error');
    await new Promise((r) => setTimeout(r, 0));
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
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
    expect(screen.getByText(/lower than the real total/i)).toBeVisible();
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
