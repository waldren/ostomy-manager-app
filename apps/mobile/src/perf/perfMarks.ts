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
 * `EXPO_PUBLIC_PERF_MARKS=1` at BUILD time turns them on. Expo inlines an
 * `EXPO_PUBLIC_*` variable as a literal, so in a build without it the check
 * below is `undefined === '1'` and every mark is dead code: an ordinary build
 * carries no instrumentation, not merely instrumentation that is switched off.
 *
 * ## What a mark may say
 *
 * `perf:<name> <milliseconds>`, and nothing else. This runs on the paths that
 * handle clinical values, and logcat is readable by anything with `adb` on a
 * debuggable build, so a mark must never carry a value, a code, an entry's
 * time, a count of entries, or an identifier. That is enforced by shape rather
 * than by care: the name is a closed union, and the only other thing written
 * is a number this module measured itself.
 *
 * ## Why the app measures itself
 *
 * `adb` input and screenshots resolve to about a second, which is coarser than
 * the thing being measured. Cold start is the exception and is measured from
 * outside, with Android's own `am start -W`.
 */

/** Every mark there is. A new one is added here, never built from a string. */
export type PerfMarkName =
  /** Save tapped → the observation and its queue row committed (validation included). */
  | 'save-write'
  /** Save tapped → Home rendering its "Saved" confirmation. What §5.1 means by a save. */
  | 'save-confirmed'
  /** Quick-Add widget tapped → the entry committed. */
  | 'quickadd-write'
  /** Unlock accepted → Home showing the patient's Quick-Add widgets. */
  | 'unlock-to-home'
  /** The 90-day local history read a history screen would make (`historyProbe.ts`). */
  | 'history-90d-query'
  /** One background sync cycle, start to finish. */
  | 'sync-cycle';

/**
 * Read exactly once, as a literal property access, so Expo's inlining can
 * replace it. `process.env['EXPO_PUBLIC_PERF_MARKS']` or a destructure would
 * not be inlined, and the flag would silently read `undefined` on a device.
 */
const ENABLED = process.env.EXPO_PUBLIC_PERF_MARKS === '1';

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
