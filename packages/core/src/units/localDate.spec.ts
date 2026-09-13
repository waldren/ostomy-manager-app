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
*/

import { describe, expect, it } from 'vitest';

import { isResolvableTimeZone, toLocalDate } from './localDate.js';

describe('toLocalDate', () => {
  it('is the reason this exists: an evening entry stays on the evening it happened', () => {
    // 8pm on 11 September in Chicago is already 01:00 on the 12th in UTC.
    // Grouping by the UTC day puts a high-output ileostomy patient's
    // evening output — the clinically interesting part, and the reason
    // overnight dehydration is the risk — onto the following day.
    const instant = new Date('2026-09-12T01:00:00.000Z');

    expect(toLocalDate(instant, 'America/Chicago')).toBe('2026-09-11');
    expect(toLocalDate(instant, 'UTC')).toBe('2026-09-12');
  });

  it('puts an early-morning entry east of Greenwich on the right day too', () => {
    // The mirror case. 00:30 in Tokyo is still the previous day in UTC.
    const instant = new Date('2026-09-11T15:30:00.000Z');

    expect(toLocalDate(instant, 'Asia/Tokyo')).toBe('2026-09-12');
    expect(toLocalDate(instant, 'UTC')).toBe('2026-09-11');
  });

  it('zero-pads, so the value sorts and compares as a date string', () => {
    expect(toLocalDate(new Date('2026-01-05T12:00:00.000Z'), 'UTC')).toBe('2026-01-05');
  });

  describe('daylight saving', () => {
    /**
     * The reason the column stores an IANA zone rather than a UTC offset.
     * An offset cannot express this: `-05:00` does not say whether the next
     * entry should be `-05:00` or `-06:00`, so a fixed offset would put
     * entries on the wrong day for half the year.
     */
    it('uses the offset in force on the day, not a fixed one', () => {
      // 04:30 UTC is 23:30 the previous day at CDT (-05:00) in July, and
      // 22:30 the previous day at CST (-06:00) in January. Both are the
      // previous local day, but via different offsets.
      expect(toLocalDate(new Date('2026-07-15T04:30:00.000Z'), 'America/Chicago')).toBe(
        '2026-07-14',
      );
      expect(toLocalDate(new Date('2026-01-15T04:30:00.000Z'), 'America/Chicago')).toBe(
        '2026-01-14',
      );
    });

    it('resolves an instant inside the spring-forward gap', () => {
      // 2026-03-08 07:30Z is 01:30 CST, half an hour before the 02:00 jump.
      expect(toLocalDate(new Date('2026-03-08T07:30:00.000Z'), 'America/Chicago')).toBe(
        '2026-03-08',
      );
    });
  });

  it('handles a zone with a non-whole-hour offset', () => {
    // Kathmandu is UTC+05:45. A derivation that assumed whole hours, or
    // that added an integer offset, gets this wrong.
    expect(toLocalDate(new Date('2026-09-11T18:20:00.000Z'), 'Asia/Kathmandu')).toBe('2026-09-12');
  });

  it('crossing a zone can put two instants on the same date out of order', () => {
    /**
     * The property `docs/sync-contract.md` and ADR-0016 both warn about:
     * `local_date` is NOT monotonic with the instant. A later instant can
     * carry an earlier date. Any code that assumes sorting by one implies
     * sorting by the other is wrong, and this is the fixture that shows it.
     */
    const earlierInstant = new Date('2026-09-12T02:00:00.000Z');
    const laterInstant = new Date('2026-09-12T03:00:00.000Z');

    // The patient flew east between entries.
    expect(toLocalDate(earlierInstant, 'Pacific/Auckland')).toBe('2026-09-12');
    expect(toLocalDate(laterInstant, 'America/Chicago')).toBe('2026-09-11');
    expect(laterInstant.getTime()).toBeGreaterThan(earlierInstant.getTime());
  });
});

describe('isResolvableTimeZone', () => {
  it.each(['UTC', 'America/Chicago', 'Asia/Tokyo', 'Europe/London', 'Asia/Kathmandu'])(
    'accepts the real zone %s',
    (zone) => {
      expect(isResolvableTimeZone(zone)).toBe(true);
    },
  );

  it.each(['-05:00', '+0200', 'UTC+2', 'GMT-5'])(
    'rejects the fixed offset %s, which cannot express DST',
    (offset) => {
      expect(isResolvableTimeZone(offset)).toBe(false);
    },
  );

  it.each(['', 'Not/AZone', 'America/Nowhere', 'x'])('rejects %o', (zone) => {
    expect(isResolvableTimeZone(zone)).toBe(false);
  });

  it('does not throw for any input, because it gates a request path', () => {
    // A throw here would be a 500 on a malformed client field, which
    // `docs/sync-contract.md` §9 tells a client to re-push indefinitely.
    expect(() => isResolvableTimeZone('💥')).not.toThrow();
  });
});
