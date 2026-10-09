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
 * `entryInstant` cannot place an entry in the future, at any hour of any day.
 *
 * Found while verifying #114's routines against a real stack: `dev-reset.sh`
 * failed with
 *
 *   colostomy-baseline generated an entry at or after "now" (day offset 1).
 *   Tier 1 would reject it as EFFECTIVE_DATE_TIME_IN_FUTURE.
 *
 * and the entry responsible was an ordinary one, not a routine. A local hour
 * late in the evening on the most recent day can still be ahead of `now` in
 * UTC: at 02:51Z, 22:00 in `America/Chicago` on day-offset 1 is 03:00Z. Whether
 * it fires depends on the RNG draw, which is why a defect that breaks the
 * primary development command for four hours in every twenty-four went
 * unnoticed — every scenario spec ran at its own fixed `now`, and none of them
 * picked one inside the window.
 *
 * So these cases walk the clock rather than choosing a time.
 */

import { describe, expect, it } from 'vitest';

import { createRng, type Rng } from '../rng.js';
import { entryInstant } from './shared.js';

/**
 * An Rng that draws a chosen hour, so a case can state the draw instead of
 * hunting for a seed that happens to produce it. Only `intBetween` is reached
 * on this path; the rest throw rather than returning a plausible number, so a
 * future change that starts using them fails here instead of passing against a
 * stub that quietly answered.
 */
function rngDrawingHour(hour: number): Rng {
  const unused = (name: string): never => {
    throw new Error(`entryInstant called Rng.${name}, which this stub does not model.`);
  };
  return {
    // The hour draw is the one with a max of 22; the minute draw takes its min.
    intBetween: (min: number, max: number) => (max === 22 ? hour : min),
    next: () => unused('next'),
    floatBetween: () => unused('floatBetween'),
    pick: () => unused('pick'),
  };
}

/** The zones the scenarios actually use, plus one east of UTC for the mirror case. */
const ZONES = ['America/Chicago', 'America/Los_Angeles', 'UTC', 'Asia/Tokyo'];

/** The default range `entryInstant` draws from; 22:00 local is the one that bites. */
const DEFAULT_HOURS: readonly [number, number] = [7, 22];

describe('entryInstant', () => {
  /**
   * Every hour of a UTC day, every scenario zone, the most recent day, and every
   * seed in a small sweep — because the failure is a conjunction of all four and
   * fixing one case while leaving the rest would look identical from here.
   */
  it('never returns an instant at or after now, whatever time it is run', () => {
    for (let utcHour = 0; utcHour < 24; utcHour += 1) {
      const now = new Date(Date.UTC(2026, 9, 9, utcHour, 30, 0));
      for (const timeZone of ZONES) {
        for (let seed = 1; seed <= 25; seed += 1) {
          const rng = createRng(seed);
          const instant = entryInstant(rng, now, 1, timeZone, DEFAULT_HOURS);

          expect(
            instant.getTime(),
            `${timeZone} at ${now.toISOString()} (seed ${String(seed)}) produced ${instant.toISOString()}`,
          ).toBeLessThan(now.getTime());
        }
      }
    }
  });

  /**
   * The exact reproduction, pinned so the fix cannot be undone by someone who
   * reads the clamp as defensive. 22:00 Chicago on 8 October is 03:00Z on the
   * 9th; `now` is nine minutes earlier.
   */
  it('clamps the hour that broke dev-reset, rather than returning it', () => {
    const now = new Date('2026-10-09T02:51:00.000Z');
    const rng = rngDrawingHour(22);

    const instant = entryInstant(rng, now, 1, 'America/Chicago', DEFAULT_HOURS);

    expect(instant.getTime()).toBeLessThan(now.getTime());
    // Clamped to an earlier hour on the SAME day, not moved to another day —
    // `assertAfterSurgery` guards the other end, and `new-post-op`'s window sits
    // close enough to its surgery date that a day's shift could cross it.
    expect(instant.toISOString().slice(0, 10)).toBe('2026-10-09');
  });

  /** The ordinary case is untouched: a draw that is already past comes back as drawn. */
  it('returns the drawn hour when it is already in the past', () => {
    const now = new Date('2026-10-09T18:00:00.000Z');
    const rng = rngDrawingHour(9);

    const instant = entryInstant(rng, now, 1, 'UTC', DEFAULT_HOURS);

    expect(instant.toISOString()).toBe('2026-10-08T09:00:00.000Z');
  });
});
