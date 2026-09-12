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

import { formatDateTime, formatVolumeQuantity } from '@ostomy/core/i18n';
import { VisuallyHidden } from '@ostomy/ui';
import { useTranslation } from 'react-i18next';

import {
  CLINICAL_DATE_TIME_OPTIONS,
  type DisplayOutputEntry,
} from '../format/formatObservationsForDisplay.js';

export interface OutputChartProps {
  readonly entries: readonly DisplayOutputEntry[];
}

const CHART_WIDTH = 600;
const CHART_HEIGHT = 220;
const MINUTES_PER_DAY = 24 * 60;

/**
 * A chronological plot of the day's stoma output (SRS §3.5).
 *
 * The `<svg>` itself is `aria-hidden`: rendering each bar as an
 * individually-labelled accessible element does not hold up well across
 * screen readers for a chart with an arbitrary number of bars, so instead —
 * per CLAUDE.md's "Charts and data display" — the exact values are always
 * available two other ways: a plain-text description immediately below the
 * chart (`VisuallyHidden`, so it does not visually duplicate the chart for
 * a sighted user) and the full `OutputTable` rendered right after it. A
 * chart is never the only place a value lives.
 */
export function OutputChart({ entries }: OutputChartProps) {
  const { t } = useTranslation();
  const maxVolume = Math.max(1, ...entries.map((entry) => entry.display.value));

  return (
    // The heading is `<h2>` and sits OUTSIDE `<figure>`.
    //
    // Two defects in one line before: it was `<h3>` under the page's only
    // `<h1>`, so the document skipped a level (WCAG 1.3.1) on a page a
    // screen-reader user navigates by heading — and there were exactly two
    // headings on it. And a heading inside `<figcaption>` is swallowed into
    // the figure's accessible name, which computed to the heading
    // concatenated with the whole caption sentence.
    <>
      <h2>{t('physicianView.chart.heading')}</h2>
      <figure>
        <figcaption>
          <p>{t('physicianView.chart.caption')}</p>
        </figcaption>

        <p>{t('physicianView.chart.axisVolume')}</p>
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          width="100%"
          role="presentation"
          aria-hidden="true"
        >
          <line x1={0} y1={CHART_HEIGHT} x2={CHART_WIDTH} y2={CHART_HEIGHT} stroke="currentColor" />
          {entries.map((entry) => {
            // UTC, not local. `packages/core`'s `formatDateTime` pins
            // `timeZone: 'UTC'` deliberately, so the table beside this chart
            // and this chart's own screen-reader description are both UTC.
            // Positioning bars by local hours made them disagree: for a
            // clinician at UTC-6, an entry listed as "2:00 AM" was drawn at the
            // 21:00 position. A chart that contradicts its own accessible
            // equivalent fails WCAG 1.1.1 on the terms this component set
            // itself, and it breaks the output-over-time correlation the
            // physician view exists to support (SRS §3.5).
            const minutesOfDay =
              entry.effectiveDateTime.getUTCHours() * 60 + entry.effectiveDateTime.getUTCMinutes();
            const x = (minutesOfDay / MINUTES_PER_DAY) * CHART_WIDTH;
            const barHeight = (entry.display.value / maxVolume) * (CHART_HEIGHT - 10);
            return (
              <rect
                key={entry.id}
                x={Math.max(0, x - 4)}
                y={CHART_HEIGHT - barHeight}
                width={8}
                height={barHeight}
                fill="currentColor"
              />
            );
          })}
        </svg>
        <p>{t('physicianView.chart.axisTime')}</p>

        <VisuallyHidden as="div">
          <p>{t('physicianView.chart.longDescriptionIntro')}</p>
          <ul>
            {entries.map((entry) => (
              <li key={entry.id}>
                {formatDateTime(entry.effectiveDateTime, undefined, CLINICAL_DATE_TIME_OPTIONS)}:{' '}
                {formatVolumeQuantity(entry.display)}
              </li>
            ))}
          </ul>
        </VisuallyHidden>
      </figure>
    </>
  );
}
