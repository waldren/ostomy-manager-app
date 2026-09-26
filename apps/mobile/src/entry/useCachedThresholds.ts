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

import { useEffect, useState } from 'react';

import { readThresholds, type CachedThresholds } from '../db/repositories/thresholdsRepository';
import type { DatabaseState } from '../db/DatabaseProvider';
import { useSyncStatus } from '../sync/SyncProvider';

/**
 * The validation thresholds this device has cached, re-read when a sync cycle
 * finishes.
 *
 * ## Why this is a hook and not three copies of an effect
 *
 * Add Output, Add Intake and Add Urine each had a byte-identical copy of this,
 * and the cache being empty blocks the save on all three. #63's wrong copy was
 * therefore wrong in three places, and CLAUDE.md already records what duplicated
 * paths do here: the observation write paths drifted for two whole sprints
 * because each named its columns separately.
 *
 * ## The three states are distinct and the screen renders something different for
 * ## each
 *
 * - `undefined` — not looked yet. The ordinary first render. Showing the
 *   cannot-save message here would flash it at every patient on every open.
 * - `null` — looked, and there is nothing. The save must be blocked:
 *   `validation_thresholds_cache` is **deliberately unseeded**, because a default
 *   there is a hardcoded threshold wearing a database costume, so validating
 *   against invented numbers is worse than refusing.
 * - a value — validate against it.
 *
 * ## Why it re-reads
 *
 * The cache fills from the sync worker's `/thresholds` call, which happens after
 * this screen can already be open. Reading once at mount left the patient looking
 * at a permanently disabled Save button with the cache sitting populated
 * underneath it, recoverable only by backing out of the screen and coming back —
 * which is #63's defect wearing a different costume, since the copy would have to
 * tell them to do that.
 *
 * `isRunning` is the signal because it flips on every cycle, so a cycle that
 * populates the cache always moves it. Re-reading on a cycle that changed nothing
 * costs one indexed SQLite read on a screen the patient has open for seconds.
 */
export function useCachedThresholds(database: DatabaseState): CachedThresholds | undefined | null {
  const { isRunning } = useSyncStatus();
  const [cached, setCached] = useState<CachedThresholds | undefined | null>(undefined);

  useEffect(() => {
    if (database.status !== 'ready') return;
    let cancelled = false;
    readThresholds(database.executor)
      .then((value) => {
        if (!cancelled) setCached(value ?? null);
      })
      .catch(() => {
        // `null`, not a thrown error: an unreadable cache and an empty one have
        // the same consequence for the patient, and the save must refuse either
        // way rather than validate against nothing.
        if (!cancelled) setCached(null);
      });
    return () => {
      cancelled = true;
    };
  }, [database, isRunning]);

  return cached;
}
