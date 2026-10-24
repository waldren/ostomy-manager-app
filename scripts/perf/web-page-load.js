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

/* global window -- runs in the page, not in Node */

/**
 * P4.S5 slice 4 (#158): what one load of `apps/web`'s physician view cost,
 * read from the browser's own timings after the page has loaded. Run in the
 * page by gstack's browse (`$B eval scripts/perf/web-page-load.js`) right
 * after a reload of a signed-in view.
 *
 * Leaves `window.__pageLoad` (browse's `eval` does not wait for an async
 * result), all in milliseconds from the start of navigation:
 * - `domContentLoaded`: the app's HTML and script parsed;
 * - `observationsResponseEnd`: the day's entries arrived (the last of the
 *   three reads the page makes before it can show a day);
 * - `largestContentfulPaint`: the largest element painted, which on this page
 *   is the day's chart or table once it has data.
 */
window.__pageLoad = { done: false };
(async () => {
  const [navigation] = performance.getEntriesByType('navigation');
  const responseEnd = (fragment) => {
    const entry = performance
      .getEntriesByType('resource')
      .filter((resource) => resource.name.includes(fragment))
      .at(-1);
    return entry === undefined ? null : Math.round(entry.responseEnd);
  };
  const lcp = await new Promise((resolve) => {
    let latest = null;
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) latest = entry.startTime;
    });
    observer.observe({ type: 'largest-contentful-paint', buffered: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(latest === null ? null : Math.round(latest));
    }, 500);
  });
  window.__pageLoad = {
    done: true,
    domContentLoaded: Math.round(navigation.domContentLoadedEventEnd),
    profileResponseEnd: responseEnd('/api/v1/profile'),
    observationsResponseEnd: responseEnd('/api/v1/observations'),
    rangesResponseEnd: responseEnd('/api/v1/ranges'),
    largestContentfulPaint: lcp,
  };
})();
