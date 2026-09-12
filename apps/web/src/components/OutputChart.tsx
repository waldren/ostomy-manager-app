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
 * Room inside the viewBox for the tick labels.
 *
 * The chart previously drew bars across the full box with no scale at all:
 * a bar's height was proportional to the day's largest entry and nothing
 * said what that was, so two days' charts looked identical whether the peak
 * was 80 mL or 800 mL. A shape that cannot be read as a quantity is a
 * picture of the data, not a plot of it.
 */
const PLOT_INSET = { left: 56, right: 12, top: 12, bottom: 28 } as const;
const PLOT_WIDTH = CHART_WIDTH - PLOT_INSET.left - PLOT_INSET.right;
const PLOT_HEIGHT = CHART_HEIGHT - PLOT_INSET.top - PLOT_INSET.bottom;

/** Every six hours. Enough to read time of day; few enough not to crowd. */
const HOUR_TICKS = [0, 6, 12, 18, 24] as const;

/** Hour-of-day only, in UTC, matching every other timestamp on this page. */
const HOUR_TICK_OPTIONS: Intl.DateTimeFormatOptions = {
  dateStyle: undefined,
  timeStyle: undefined,
  hour: 'numeric',
};

/**
 * Unit form for text that exists only to be spoken.
 *
 * Screen readers pronounce the abbreviated unit letter by letter: the
 * default `'short'` turns "350 mL" into "three hundred fifty M L", which is
 * not how a volume is said and not how a clinician hears one. `'long'`
 * produces "350 milliliters". The visible table beside this chart keeps the
 * short form, which is what a clinician expects to read.
 *
 * A named constant rather than an inline `'long'` because the copy lint
 * cannot tell a formatter enum from a hardcoded user-facing string, and the
 * distinction is worth stating rather than suppressing.
 */
const SPOKEN_UNIT_DISPLAY = 'long';

/**
 * A round number at or above the day's largest entry, so the axis reads in
 * human steps (0, 250, 500) rather than off the tallest bar (0, 173, 347).
 */
function niceCeiling(value: number): number {
  if (value <= 0) {
    return 1;
  }
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  return Math.ceil(value / magnitude) * magnitude;
}

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

  // The unit the day is being displayed in. Taken from the entries rather
  // than passed in, because these are already converted to the target
  // system and the axis must name the unit the BARS are drawn in.
  const unit = entries[0]?.display.unit ?? 'mL';

  // The axis label's unit is DERIVED from the same formatter that writes the
  // tick labels, not from the unit code. `'oz'` renders as "fl oz", so
  // interpolating the code gave an axis reading "Output volume (oz)" above
  // gridlines reading "12 fl oz" — two names for one unit, on one chart.
  // Formatting zero and stripping the number is what guarantees the two
  // cannot drift, which naming it separately would not.
  const unitLabel = formatVolumeQuantity({ value: 0, unit }).replace(/^[\d\s.,]+/, '');
  const axisMax = niceCeiling(Math.max(...entries.map((entry) => entry.display.value), 0));

  // Anchored to the day being charted, so the hour ticks are that day's
  // hours rather than today's. Every entry is within one UTC day (the page
  // queries a single day's bounds), so the first is representative.
  const dayStart = entries[0]
    ? new Date(
        Date.UTC(
          entries[0].effectiveDateTime.getUTCFullYear(),
          entries[0].effectiveDateTime.getUTCMonth(),
          entries[0].effectiveDateTime.getUTCDate(),
        ),
      )
    : new Date(0);

  const volumeTicks = [0, axisMax / 2, axisMax];

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

        {/*
          The axis labels name their unit. "Output volume" alone left the
          scale ambiguous on a page with a metric/imperial toggle — the same
          bar means 350 mL or 12 fl oz depending on a control elsewhere on
          the page, and the chart said neither.
        */}
        <p>{t('physicianView.chart.axisVolume', { unit: unitLabel })}</p>
        <svg
          viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          width="100%"
          role="presentation"
          aria-hidden="true"
        >
          {/*
            Gridlines and their labels. `aria-hidden` covers the whole svg,
            so none of this text reaches assistive technology — the values
            themselves are in the table and the description below, and these
            exist so a SIGHTED reader can read a quantity off a bar.
          */}
          {volumeTicks.map((tick) => {
            const y = PLOT_INSET.top + PLOT_HEIGHT - (tick / axisMax) * PLOT_HEIGHT;
            return (
              <g key={tick}>
                <line
                  x1={PLOT_INSET.left}
                  y1={y}
                  x2={PLOT_INSET.left + PLOT_WIDTH}
                  y2={y}
                  stroke="currentColor"
                  opacity={tick === 0 ? 1 : 0.25}
                />
                <text x={PLOT_INSET.left - 8} y={y + 4} textAnchor="end" fontSize={12}>
                  {formatVolumeQuantity({ value: tick, unit })}
                </text>
              </g>
            );
          })}

          {HOUR_TICKS.map((hour) => {
            const x = PLOT_INSET.left + (hour / 24) * PLOT_WIDTH;
            const tickAt = new Date(dayStart.getTime() + hour * 60 * 60 * 1000);
            return (
              <text
                key={hour}
                x={x}
                y={PLOT_INSET.top + PLOT_HEIGHT + 20}
                textAnchor="middle"
                fontSize={12}
              >
                {formatDateTime(tickAt, undefined, HOUR_TICK_OPTIONS)}
              </text>
            );
          })}

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
            const x = PLOT_INSET.left + (minutesOfDay / MINUTES_PER_DAY) * PLOT_WIDTH;
            const barHeight = (entry.display.value / axisMax) * PLOT_HEIGHT;
            return (
              <rect
                key={entry.id}
                x={Math.max(PLOT_INSET.left, x - 4)}
                y={PLOT_INSET.top + PLOT_HEIGHT - barHeight}
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
                {formatVolumeQuantity(entry.display, undefined, SPOKEN_UNIT_DISPLAY)}
              </li>
            ))}
          </ul>
        </VisuallyHidden>
      </figure>
    </>
  );
}
