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

import type { DatabaseState } from '../db/DatabaseProvider';
import { listQuickAddCandidates } from '../db/repositories/quickAddRepository';
import { now as clockNow, toWireInstant } from '../lib/utils/clock';

import {
  QUICK_ADD_CODES,
  rankQuickAddSuggestions,
  recentWindowStart,
  type QuickAddSuggestion,
} from './quickAddSuggestions';

/**
 * The dashboard's Quick-Add suggestions, read from the local store (P3.S4).
 *
 * ## There is no loading state, and that is the point
 *
 * §5.1 requires a Quick-Add tap to "resolve immediately, without a loading
 * state". The shape that delivers it: `undefined` until the first read
 * settles, and the dashboard renders **nothing at all** for that — not a
 * spinner, not a skeleton, not a heading with an empty body. A patient who
 * blinks and misses it sees the section appear; one with no repeated entries
 * never sees it, which is the same render and needs no separate empty state.
 *
 * `undefined` and `[]` are therefore deliberately NOT distinguished by the
 * caller. Distinguishing them is what would reintroduce a loading state.
 *
 * ## Refreshed on the same signal the counts use
 *
 * `reload` is exposed so the screen can re-read after a tap logs an entry:
 * the new row changes the counts behind the widget's "you logged this N times
 * recently" line, and a widget that still said two after the third would be
 * quietly wrong about the patient's own data. No polling and no subscription —
 * the local store has no change feed, and inventing one for a dashboard that
 * is re-entered on every save would be machinery for nothing.
 */
export function useQuickAddSuggestions(database: DatabaseState): {
  readonly suggestions: readonly QuickAddSuggestion[] | undefined;
  readonly reload: () => void;
} {
  const [suggestions, setSuggestions] = useState<readonly QuickAddSuggestion[] | undefined>(
    undefined,
  );
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => {
    setNonce((previous) => previous + 1);
  }, []);

  useEffect(() => {
    if (database.status !== 'ready') return undefined;
    let cancelled = false;

    void listQuickAddCandidates(database.executor, {
      codes: QUICK_ADD_CODES,
      since: toWireInstant(recentWindowStart(clockNow())),
    })
      .then((candidates) => {
        if (!cancelled) setSuggestions(rankQuickAddSuggestions(candidates));
      })
      .catch(() => {
        // An empty list, not a thrown render. Quick-Add is an accelerator: a
        // patient who cannot see it can still use the four entry buttons right
        // below, so a failed read must cost them a shortcut and never the
        // screen. The same reasoning `home.tsx` applies to its pending count,
        // except that there "unknown" is its own answer worth showing and here
        // there is nothing to say.
        if (!cancelled) setSuggestions([]);
      });

    return () => {
      cancelled = true;
    };
  }, [database, nonce]);

  return { suggestions, reload };
}
