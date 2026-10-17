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

import { useCallback, useEffect, useState } from 'react';

import type { SqliteExecutor } from '../db/executor';
import { listOverlayRangeWrites, readRangeCache } from '../db/repositories/rangesRepository';

import { buildTargetRangeViews, type TargetRangeView } from './targetRangeView';

/**
 * Three states. `never-fetched` is not an error: it is a phone that has not yet
 * reached the server since this build was installed, and the screen says to
 * connect rather than showing an empty list, which would read as "you have no
 * target ranges".
 */
export type TargetRangesState =
  | { readonly status: 'loading' }
  | { readonly status: 'never-fetched' }
  | { readonly status: 'ready'; readonly views: readonly TargetRangeView[] };

/**
 * The target ranges screen's data: the cached answer with this phone's own
 * changes over it (`buildTargetRangeViews`).
 *
 * Re-read whenever `syncSettled` changes, which the screen ties to the sync
 * worker finishing a cycle. That cycle is what refreshes the cache, and a range
 * set on another device arrives through it.
 */
export function useTargetRanges(
  executor: SqliteExecutor | undefined,
  syncSettled: unknown,
): { readonly state: TargetRangesState; readonly reload: () => Promise<void> } {
  const [state, setState] = useState<TargetRangesState>({ status: 'loading' });

  const reload = useCallback(async () => {
    if (executor === undefined) return;
    const cache = await readRangeCache(executor);
    if (cache === undefined) {
      setState({ status: 'never-fetched' });
      return;
    }
    const writes = await listOverlayRangeWrites(executor);
    setState({ status: 'ready', views: buildTargetRangeViews(cache.ranges, writes) });
  }, [executor]);

  useEffect(() => {
    void reload();
  }, [reload, syncSettled]);

  return { state, reload };
}
