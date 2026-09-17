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

import type { SqliteExecutor } from './executor';
import { countByStatus } from './repositories/syncQueueRepository';

/**
 * How many of this patient's entries exist only on this phone.
 *
 * Sign-out purges the local database (ADR-0014) — the file is deleted and
 * the SQLCipher key destroyed — so anything still in `sync_queue` is gone
 * for good. `AuthContext` has carried a "KNOWN GAP" comment about this since
 * P2.S2a, deferred until the sync worker existed. It does now, so the
 * warning has something true to say: wait, and it will send.
 *
 * **All three statuses count.** It is tempting to count only `queued`:
 *
 * - `in_flight` is an operation whose push is mid-request or whose last
 *   attempt died before a response. Its fate is unknown (§9.3), which means
 *   it may never have reached the server — indistinguishable, from here,
 *   from one that has not been tried.
 * - `rejected` is an entry the patient made that the server refused and that
 *   is waiting in the correction inbox (§3.5). It is the *most* important
 *   one to warn about: it will never sync on its own, so signing out
 *   destroys it with certainty rather than probability.
 *
 * Counting only `queued` would tell a patient with a full correction inbox
 * that everything had been sent.
 */
export async function countUnsyncedEntries(executor: SqliteExecutor): Promise<number> {
  const counts = await countByStatus(executor);
  return counts.queued + counts.inFlight + counts.rejected;
}

/**
 * The count, or `undefined` when it could not be determined.
 *
 * The distinction matters at the sign-out prompt: "0 unsent entries" and "we
 * could not check" must not render the same way. A failed read here — a
 * database that will not open, a purge already in flight — would otherwise
 * look like a clean queue and let someone sign out believing nothing was
 * lost.
 */
export async function tryCountUnsyncedEntries(
  executor: SqliteExecutor,
): Promise<number | undefined> {
  try {
    return await countUnsyncedEntries(executor);
  } catch {
    return undefined;
  }
}
