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
 * The patient's calendar day for a clinical instant (ADR-0016).
 *
 * Shared rather than implemented twice. The server derives and stores
 * `local_date`; `apps/mobile` derives the same value locally so an offline
 * day total is right before the entry has ever synced. Two implementations
 * of "which day was this" that drift by an hour is a defect nothing would
 * detect — the rows would simply group differently on the device and on the
 * server, and only a patient comparing the two would ever notice.
 */

/**
 * Whether an IANA zone identifier resolves in this runtime.
 *
 * This is the whole of the server's validation of `enteredTimezone`, and
 * deliberately so: it is a client-asserted field on exactly the footing of
 * `enteredMeasurementSystem` (ADR-0012). Only the device knows what the
 * patient's clock said. The server checks the identifier is real, never
 * that it is the *right* one — second-guessing it would reject correct
 * entries from a travelling patient, which is the case the field exists
 * for.
 *
 * Rejects a fixed UTC offset (`-05:00`, `+0200`) as well as nonsense —
 * explicitly, because modern `Intl` ACCEPTS offset forms as time zone
 * identifiers. `UTC` and `Etc/GMT+5` stay valid: they are real IANA
 * identifiers with real DST rules (none), unlike a bare offset.
 */
export function isResolvableTimeZone(zone: string): boolean {
  if (zone.length === 0) {
    return false;
  }

  // Reject offset forms explicitly, because `Intl` ACCEPTS them.
  //
  // Modern engines treat `-05:00`, `+0200` and `+05` as valid time zone
  // identifiers, so relying on the `Intl` probe alone would let a client
  // store an offset in a column documented to hold an IANA zone. That is
  // the one input this field must not take: an offset cannot express DST —
  // `-05:00` does not say whether the next entry is `-05:00` or `-06:00` —
  // so the patient's day would be computed wrongly for half the year, and
  // the value is permanent per row.
  if (/^[+-]/.test(zone)) {
    return false;
  }
  try {
    // Throws `RangeError` for an unknown or malformed identifier. There is
    // no non-throwing probe in `Intl`, and the list of valid zones is the
    // runtime's, not something to hardcode: tzdata changes, and a
    // hand-maintained list would start rejecting real zones.
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The calendar date `instant` fell on, in `zone`, as `YYYY-MM-DD`.
 *
 * Uses `formatToParts` rather than string parsing of a formatted date:
 * locale formats vary in order and separator, and `en-CA` happening to
 * produce ISO order is a coincidence to rely on only by accident.
 *
 * Throws if the zone does not resolve. Callers validate first
 * (`isResolvableTimeZone`); this is a guard against a path that forgot,
 * not an error a client can reach.
 */
export function toLocalDate(instant: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);

  const get = (type: 'year' | 'month' | 'day'): string => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new Error(`Could not derive a local date in time zone "${zone}".`);
    }
    return part.value;
  };

  return `${get('year')}-${get('month')}-${get('day')}`;
}
