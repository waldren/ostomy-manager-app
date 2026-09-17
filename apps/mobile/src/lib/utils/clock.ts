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
 * The single indirection over "now" in this app. `packages/core`'s Tier 1
 * validation takes `now` as an injected argument rather than reading the
 * ambient clock (see `validation/tier1.ts`'s `VolumetricEntryInput.now`
 * doc comment) specifically so it stays a pure, testable function — this
 * wrapper is what lets every call site in this app follow the same
 * discipline instead of sprinkling `new Date()` through the codebase.
 */
export function now(): Date {
  return new Date();
}

/**
 * The device's current IANA time zone (ADR-0016).
 *
 * Read at entry time and stored on the row, never re-derived later: a
 * patient who travels or relocates would otherwise have their whole
 * history regrouped onto days they did not live, which is the same
 * mutable-source trap ADR-0012 describes for the measurement system.
 *
 * Falls back to UTC if the runtime cannot report one. That is a real
 * possibility on a misconfigured device, and the alternative — refusing the
 * entry — would lose a patient's data over a device setting they cannot
 * see. UTC is wrong-but-recorded rather than absent, and the row still says
 * which zone it was grouped by.
 */
export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** RFC 3339, UTC, exactly three fractional digits — `docs/sync-contract.md` §7.3's wire form for every timestamp. `Date#toISOString()` already produces this exact shape. */
export function toWireInstant(date: Date): string {
  return date.toISOString();
}
