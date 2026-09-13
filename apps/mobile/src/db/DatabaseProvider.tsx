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

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { getDatabase } from './database';
import type { SqliteExecutor } from './executor';

/**
 * Opens (and fully migrates) the local database once, at app start, and
 * makes the resulting `SqliteExecutor` available to any screen via
 * `useDatabase()`. `app/home.tsx` uses this in P2.S2a only to prove the
 * schema is live and to display the sync queue's current size — the Add
 * Output screen and sync worker (P2.S2b) are the real consumers this
 * exists for.
 */
const DatabaseContext = createContext<SqliteExecutor | undefined>(undefined);

export function DatabaseProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [executor, setExecutor] = useState<SqliteExecutor | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getDatabase().then((db) => {
      if (!cancelled) setExecutor(db);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <DatabaseContext.Provider value={executor}>{children}</DatabaseContext.Provider>;
}

/** `undefined` until the database has finished opening and migrating — callers render a loading state until then, never a query attempt against `undefined`. */
export function useDatabase(): SqliteExecutor | undefined {
  return useContext(DatabaseContext);
}
