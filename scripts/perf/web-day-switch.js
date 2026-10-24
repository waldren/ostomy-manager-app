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

/* global window, document, requestAnimationFrame, MutationObserver -- runs in the page, not in Node */

/**
 * P4.S5 slice 4 (#158): times `apps/web`'s day switching, run in the page by
 * gstack's browse (`$B eval scripts/perf/web-day-switch.js`) on a signed-in
 * physician view.
 *
 * Each sample: click "Show the previous day", then wait until the page's own
 * status line announces the new day as loaded ("N entries loaded for <date>")
 * and one more animation frame has passed, so the new day has been painted.
 * That is the moment a reader sees the day they asked for, which is what SRS
 * §5.1's "responsive when switching ... date ranges" is about.
 *
 * Leaves the samples on `window.__daySwitch` (browse's `eval` does not wait
 * for an async result): `{ done, error, samples }`, the samples in order, each
 * with the entry count the page reported, so a cost that grows with the size
 * of the day can be seen. Read them with
 * `$B js "JSON.stringify(window.__daySwitch)"` once `done` is true.
 */
window.__daySwitch = { done: false, error: null, samples: [] };
(async () => {
  const SWITCHES = 40;
  const TIMEOUT_MS = 15000;
  // The page's one status line: "Loading this day's records..." while a day
  // loads, "N entries loaded for <date>." once it has. A sample ends only after
  // the line has said "Loading" and then names a different day: in the render
  // the click causes, the date has changed but the previous day's "loaded"
  // state has not yet been replaced, so for a moment the line names the new
  // date before anything has been fetched. Ending there measured 4 to 13 ms.
  const statusLine = () => document.querySelector('[role="status"]')?.textContent ?? '';
  const loadedText = () => (/loaded for/.test(statusLine()) ? statusLine() : '');
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  const previousDay = () =>
    [...document.querySelectorAll('button')].find(
      (button) => (button.textContent ?? '').trim() === 'Show the previous day',
    );

  const samples = window.__daySwitch.samples;
  for (let i = 0; i < SWITCHES; i += 1) {
    const before = loadedText();
    const button = previousDay();
    if (button === undefined) throw new Error('no "Show the previous day" button on the page');
    const start = performance.now();
    // Every change the status line goes through, recorded as it happens. A fast
    // day can show "Loading" and finish inside one animation frame, so polling
    // per frame could miss it and wait forever.
    await new Promise((resolve, reject) => {
      let sawLoading = false;
      const line = document.querySelector('[role="status"]');
      const check = () => {
        if (/Loading/.test(statusLine())) sawLoading = true;
        const now = loadedText();
        if (sawLoading && now !== '' && now !== before) {
          observer.disconnect();
          clearTimeout(timer);
          resolve();
        }
      };
      const observer = new MutationObserver(check);
      observer.observe(line, { childList: true, characterData: true, subtree: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`timed out: ${statusLine()}`));
      }, TIMEOUT_MS);
      button.click();
      check();
    });
    await nextFrame();
    const ms = Math.round((performance.now() - start) * 10) / 10;
    const entries = Number((loadedText().match(/(\d+) entr(?:y|ies) loaded/) ?? [])[1] ?? NaN);
    samples.push({ ms, entries });
  }
  window.__daySwitch.done = true;
})().catch((error) => {
  window.__daySwitch.error = String(error);
  window.__daySwitch.done = true;
});
