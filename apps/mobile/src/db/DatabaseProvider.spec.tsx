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
 * Tests for the database provider.
 *
 * This component had no tests, and that is exactly why a broken fix for the
 * stale-executor defect shipped: the repair read a generation counter
 * during render, on the assumption that a purge would cause a re-render.
 * It does not. `AuthProvider` returns `{children}` — an element object
 * created once by `RootLayout` — so when auth state changes React sees a
 * reference-identical child and bails out of this subtree entirely, and
 * `DatabaseProvider` is not an `AuthContext` consumer. It re-rendered only
 * from its own state, which stops changing after the first open.
 *
 * These tests drive the provider through a purge directly, which is the
 * only thing that would have caught it.
 */

import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { DatabaseProvider, useDatabaseState } from './DatabaseProvider';
import { getDatabase, resetDatabaseForTests, withDatabaseClosed } from './database';

const mockOpen = jest.fn();

jest.mock('./database', () => {
  const actual = jest.requireActual('./database');
  return { ...actual };
});

jest.mock('./expoSqliteExecutor', () => ({
  DATABASE_NAME: 'test.db',
  openExpoSqliteExecutor: () => mockOpen(),
}));

jest.mock('./migrations', () => ({ runMigrations: jest.fn(async () => undefined) }));

function fakeExecutor(label: string) {
  return {
    label,
    execAsync: jest.fn(async () => undefined),
    runAsync: jest.fn(async () => ({ changes: 0 })),
    getAllAsync: jest.fn(async () => []),
    withTransactionAsync: jest.fn(async (fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn(async () => undefined),
  };
}

function Probe() {
  const state = useDatabaseState();
  return (
    <Text testID="state">
      {state.status === 'ready'
        ? (state.executor as unknown as { label: string }).label
        : state.status}
    </Text>
  );
}

async function renderProvider() {
  await act(async () => {
    render(
      <DatabaseProvider>
        <Probe />
      </DatabaseProvider>,
    );
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetDatabaseForTests();
  let n = 0;
  mockOpen.mockImplementation(async () => fakeExecutor(`db-${++n}`));
});

describe('DatabaseProvider', () => {
  it('exposes the executor once it is open', async () => {
    await renderProvider();

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('db-1'));
  });

  it('re-opens after the database is invalidated, instead of serving a closed handle', async () => {
    /**
     * The defect, and it fired on the FIRST LOGIN OF EVERY INSTALL: a fresh
     * database has no owner, so `completeLogin` purges — closing and
     * deleting the file this provider is holding. Serving that dead handle
     * afterwards costs a swallowed count today and the patient's entry once
     * the Add Output screen saves through it.
     */
    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('db-1'));

    await act(async () => {
      await withDatabaseClosed(async () => undefined);
    });

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('db-2'));
  });

  it('surfaces an error state rather than a spinner that never resolves', async () => {
    // Opening the local store can genuinely fail — the keychain is
    // unavailable before the device's first unlock, and a migration can
    // throw. The unhandled rejection left every screen waiting forever.
    mockOpen.mockRejectedValueOnce(new Error('keychain unavailable'));

    await renderProvider();

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));
  });

  it('recovers on the next invalidation after a failed open', async () => {
    mockOpen.mockRejectedValueOnce(new Error('keychain unavailable'));
    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('error'));

    await act(async () => {
      await withDatabaseClosed(async () => undefined);
    });

    // Any open executor, not a particular one: the rejected first attempt
    // never produced a label, so the recovered open is `db-1`.
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent(/^db-\d+$/));
  });

  it('does not re-open on an unrelated re-render', async () => {
    // The counter must drive re-opening, not renders. Otherwise every
    // render of an ancestor reopens the database.
    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('db-1'));

    await act(async () => {
      await getDatabase();
    });

    expect(mockOpen).toHaveBeenCalledTimes(1);
  });
});
