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
 * Performance marks for the P4.S5 spike (#158, SRS §5.1), off unless a build
 * asks for them.
 *
 * Two conditions, both inlined by Expo at BUILD time:
 *
 * - `EXPO_PUBLIC_PERF_MARKS=1`. Without it the check below is a constant
 *   `false`, so an ordinary build carries no working instrumentation.
 * - **`EXPO_PUBLIC_API_URL` is plain `http://`.** Only the local development
 *   stack is served that way, and it holds synthetic data only; staging and
 *   production are always TLS. So a flagged build pointed at real data writes
 *   nothing, mechanically, rather than because someone remembered not to ship
 *   one (#162 privacy review). It is the guarantee the rest of this header
 *   depends on.
 *
 * ## What a mark may say, and what it still reveals
 *
 * `perf:<name> <milliseconds>`, and nothing else: never a value, a code, an
 * entry's time, a count of entries, or an identifier. That is enforced by
 * shape rather than by care: the name is a closed union, and the only other
 * thing written is a number this module measured itself.
 *
 * That is not the same as revealing nothing, and the difference is why the
 * condition above exists:
 *
 * - **Where the lines go.** React Native does not strip `console.log` from a
 *   release build, so a line reaches logcat in debug and release alike. It is
 *   readable through `adb` on any phone with USB debugging enabled, and it is
 *   included in an Android bug report. Ordinary apps cannot read it.
 * - **Each line is timestamped by logcat.** A `save-write` at 02:10, 03:40 and
 *   05:05 says when someone emptied a pouch, with no value on it. All four entry
 *   screens share one name, so the kind of entry is not revealed.
 * - **Durations leak sizes.** `history-90d-query` grows with the number of rows
 *   read, a noisy proxy for how much a patient logged; a `sync-cycle` that
 *   pushed takes longer than one that did not.
 *
 * None of that matters on a development device holding synthetic data, which
 * is the only place the condition above lets a mark be written.
 *
 * ## Why the app measures itself
 *
 * `adb` input and screenshots resolve to about a second, which is coarser than
 * the thing being measured. Cold start is the exception and is measured from
 * outside, with Android's own `am start -W`.
 */

/** Every mark there is. A new one is added here, never built from a string. */
export type PerfMarkName =
  /** A validated save → the observation and its queue row committed. Validation is synchronous and excluded. */
  | 'save-write'
  /** A validated save → Home rendering its "Saved" confirmation. What §5.1 means by a save. */
  | 'save-confirmed'
  /** A Quick-Add tap that logs directly → the entry committed. */
  | 'quickadd-write'
  /** Unlock accepted → Home showing the patient's Quick-Add widgets. */
  | 'unlock-to-home'
  /** The 90-day local history read a history screen would make (`historyProbe.ts`). */
  | 'history-90d-query'
  /** One background sync cycle, start to finish. */
  | 'sync-cycle';

/**
 * Read exactly once, as literal property accesses, so Expo's inlining can
 * replace them. A bracket access or a destructure is not inlined, and would
 * silently read `undefined` on a device. Both fail safe: `undefined` is off.
 */
const ENABLED =
  process.env.EXPO_PUBLIC_PERF_MARKS === '1' &&
  (process.env.EXPO_PUBLIC_API_URL ?? '').startsWith('http://');

export function perfMarksEnabled(): boolean {
  return ENABLED;
}

const openSpans = new Map<PerfMarkName, number>();

/** Starts (or restarts) a span. A span started again before it ends measures from the later start. */
export function startSpan(name: PerfMarkName): void {
  if (!ENABLED) return;
  openSpans.set(name, performance.now());
}

/**
 * Ends a span and writes its mark. A span that was never started, or was
 * already ended, writes nothing: Home ends `save-confirmed` on every render
 * that shows the confirmation, and only one of those follows a save.
 */
export function endSpan(name: PerfMarkName): void {
  if (!ENABLED) return;
  const start = openSpans.get(name);
  if (start === undefined) return;
  openSpans.delete(name);
  writeMark(name, performance.now() - start);
}

/** Forgets a span without writing it: the step it measured did not happen. */
export function cancelSpan(name: PerfMarkName): void {
  if (!ENABLED) return;
  openSpans.delete(name);
}

/** Times one asynchronous step and writes its mark, whether or not it succeeds. */
export async function timeAsync<T>(name: PerfMarkName, step: () => Promise<T>): Promise<T> {
  if (!ENABLED) return step();
  const start = performance.now();
  try {
    return await step();
  } finally {
    writeMark(name, performance.now() - start);
  }
}

function writeMark(name: PerfMarkName, ms: number): void {
  // The one console call in the app's own code. `no-console` exists because the
  // realistic leak is a handler logging a payload; this line can write only a
  // name from the union above and a number measured here, and only in a build
  // that asked for it. Read by `adb logcat`.
  // eslint-disable-next-line no-console -- P4.S5 perf marks, see above
  console.log(`perf:${name} ${ms.toFixed(1)}`);
}

/** Test-only: forgets every open span. */
export function resetPerfMarksForTests(): void {
  openSpans.clear();
}
