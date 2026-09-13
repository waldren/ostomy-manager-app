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

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { getDatabase, getDatabaseGeneration, subscribeToDatabaseGeneration } from './database';
import type { SqliteExecutor } from './executor';

/**
 * Opens (and fully migrates) the local database once, at app start, and
 * makes the resulting `SqliteExecutor` available to any screen via
 * `useDatabase()`. `app/home.tsx` uses this in P2.S2a only to prove the
 * schema is live and to display the sync queue's current size — the Add
 * Output screen and sync worker (P2.S2b) are the real consumers this
 * exists for.
 */
/**
 * `'opening'` until the database is ready. `'error'` is terminal for this
 * attempt and exists so a screen can render a recovery instead of a
 * spinner that never resolves — opening the local store can genuinely
 * fail (keychain unavailable before the device's first unlock, a migration
 * throwing), and the previous code let that rejection go unhandled.
 */
export type DatabaseState =
  | { readonly status: 'opening' }
  | { readonly status: 'ready'; readonly executor: SqliteExecutor }
  | { readonly status: 'error' };

const DatabaseContext = createContext<DatabaseState>({ status: 'opening' });

export function DatabaseProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [executor, setExecutor] = useState<SqliteExecutor | undefined>(undefined);
  const [error, setError] = useState(false);
  /**
   * Re-opens when the database is invalidated.
   *
   * The effect used to run once with `[]` and cache the executor forever. A
   * purge closes and DELETES the file, and one fires on the first login of
   * every install — a fresh database has no owner, so `completeLogin` sees
   * a mismatch and purges. The provider then handed every screen a closed
   * handle for the rest of the process. Harmless while the only consumer
   * was a count; the entry screen's save path is next.
   */
  const generation = useSyncExternalStore(subscribeToDatabaseGeneration, getDatabaseGeneration);

  useEffect(() => {
    let cancelled = false;
    setExecutor(undefined);
    setError(false);
    getDatabase()
      .then((db) => {
        if (!cancelled) setExecutor(db);
      })
      .catch(() => {
        // Without this the rejection was unhandled and the provider simply
        // never produced a database — a screen waiting on `useDatabase()`
        // renders its loading state forever with nothing said. Opening the
        // local store can genuinely fail: the keychain is unavailable
        // before the device's first unlock, and a migration can throw.
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [generation]);

  const state: DatabaseState = error
    ? { status: 'error' }
    : executor
      ? { status: 'ready', executor }
      : { status: 'opening' };

  return <DatabaseContext.Provider value={state}>{children}</DatabaseContext.Provider>;
}

/** `undefined` until the database has finished opening and migrating — callers render a loading state until then, never a query attempt against `undefined`. */
export function useDatabase(): SqliteExecutor | undefined {
  const state = useContext(DatabaseContext);
  return state.status === 'ready' ? state.executor : undefined;
}

/** The full state, for a screen that must distinguish "still opening" from "failed to open". */
export function useDatabaseState(): DatabaseState {
  return useContext(DatabaseContext);
}
