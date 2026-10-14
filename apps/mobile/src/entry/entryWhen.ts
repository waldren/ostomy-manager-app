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
 * The arithmetic behind the entry screens' "When was this?" field (#135, SRS
 * §3.1 AC 3), with no React and no native picker in it.
 *
 * ## Whose clock
 *
 * Everything here works in the JavaScript runtime's local zone, which on a
 * device is the zone `deviceTimeZone()` reports and therefore the zone stored
 * on the row as `entered_timezone` (ADR-0016). That is deliberate: the patient
 * picks "02:00 yesterday" off their own wall clock, the row's `local_date` is
 * derived in that same zone, and the surgery-date rule compares calendar days
 * in it (ADR-0016 Amendment 1). Building any of these from UTC parts would
 * move a 23:30 entry onto the next day for everyone west of UTC — onto the
 * wrong daily total, which is the very harm a backdated entry exists to undo.
 */

/**
 * The instant a patient meant when they picked a day in one dialog and a time
 * in the next.
 *
 * Seconds and milliseconds are zeroed. The dialogs offer neither, and carrying
 * them over from whichever `Date` seeded the picker would record "02:00:41.337"
 * for an event the patient described as "two o'clock".
 *
 * A wall-clock time that does not exist — the hour skipped when clocks go
 * forward — is resolved by the `Date` constructor to the instant after the
 * gap. That is the conventional reading, and the alternative (refusing) would
 * strand a real entry over a once-a-year quirk the patient cannot see.
 */
export function combineLocalDateAndTime(datePart: Date, timePart: Date): Date {
  return new Date(
    datePart.getFullYear(),
    datePart.getMonth(),
    datePart.getDate(),
    timePart.getHours(),
    timePart.getMinutes(),
    0,
    0,
  );
}

/**
 * The first day the date dialog lets a patient choose: local midnight on their
 * surgery date, or `undefined` when no surgery date is known.
 *
 * A convenience, NOT the rule. The dialog greying out earlier days saves a
 * patient a pointless round-trip, but the Tier 1 check in
 * `@ostomy/core/validation` is what decides, and it still runs on save — a
 * picker bound is a UI property, and CLAUDE.md is explicit that client-side
 * affordances are never the enforcement.
 *
 * Built from its parts, never `new Date('YYYY-MM-DD')`: that form is read as
 * UTC midnight, which is the previous evening for everyone west of UTC and
 * would offer them a day before their surgery.
 */
export function earliestPickableDate(surgeryDate: string | null): Date | undefined {
  if (surgeryDate === null) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(surgeryDate);
  if (match === null) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/**
 * Whether this locale writes times on a 24-hour clock, for the time dialog.
 *
 * Read from `Intl` rather than hardcoded either way: CLAUDE.md requires
 * locale-aware time formatting from day one, and a dialog showing "14:00"
 * beside a field that renders "2:00 PM" asks the patient to translate between
 * them. `h11`/`h12` are the 12-hour cycles; anything else is 24-hour.
 */
export function uses24HourClock(locale?: string): boolean {
  const { hourCycle } = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions();
  if (hourCycle !== undefined) return hourCycle === 'h23' || hourCycle === 'h24';
  // An engine that reports no hourCycle: fall back to whether it formats a
  // day period ("PM") at all.
  return !new Intl.DateTimeFormat(locale, { hour: 'numeric' })
    .formatToParts(new Date(2026, 0, 1, 15))
    .some((part) => part.type === 'dayPeriod');
}
