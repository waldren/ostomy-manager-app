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

import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DisplayOutputEntry } from '../format/formatObservationsForDisplay.js';
import { OutputChart } from './OutputChart.js';
import '../i18n/index.js';

const entries: readonly DisplayOutputEntry[] = [
  {
    id: 'a',
    effectiveDateTime: new Date('2026-09-11T08:00:00.000Z'),
    display: { value: 100, unit: 'mL' },
    method: 'measured',
  },
];

describe('OutputChart — never the sole carrier of information for a screen-reader user', () => {
  it('hides the decorative SVG from assistive technology', () => {
    const { container } = render(<OutputChart entries={entries} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('provides every value from the chart as accessible text, not only visually', () => {
    const { container } = render(<OutputChart entries={entries} />);
    // Scoped to the visually-hidden description rather than the whole
    // document: the gridline labels also contain volumes now, and a bare
    // document-wide match would pass on those while the description was
    // empty — which is the exact failure this test exists to prevent.
    const description = container.querySelector('.ostomyVisuallyHidden');
    expect(description).not.toBeNull();
    expect(within(description as HTMLElement).getByText(/100 milliliters/)).toBeInTheDocument();
  });

  it('spells the unit out in the description, because a screen reader reads "mL" as letters', () => {
    const { container } = render(<OutputChart entries={entries} />);
    const description = container.querySelector('.ostomyVisuallyHidden') as HTMLElement;
    // "350 mL" is announced "three hundred fifty M L". The short form is
    // right for the visible table and wrong for text that only ever gets
    // spoken.
    expect(description.textContent).toContain('milliliters');
    expect(description.textContent).not.toMatch(/\d+\s*mL/);
  });

  it('names the unit on the volume axis, in the system being displayed', () => {
    // The page carries a metric/imperial toggle, so an unqualified "Output
    // volume" leaves the same bar meaning 350 mL or 12 fl oz depending on a
    // control elsewhere on the page.
    const { rerender } = render(<OutputChart entries={entries} />);
    expect(screen.getByText(/Output volume \(mL\)/)).toBeVisible();

    rerender(<OutputChart entries={[{ ...entries[0]!, display: { value: 3, unit: 'oz' } }]} />);
    expect(screen.getByText(/Output volume \(fl oz\)/)).toBeVisible();
  });

  it('labels the time axis', () => {
    render(<OutputChart entries={entries} />);
    expect(screen.getByText('Time of day')).toBeVisible();
  });

  it('draws a readable scale, so a bar height means a quantity', () => {
    // Without gridline labels a bar was proportional to the day's largest
    // entry and nothing said what that was — two days looked identical
    // whether the peak was 80 mL or 800 mL.
    const { container } = render(<OutputChart entries={entries} />);
    const svgText = Array.from(container.querySelectorAll('svg text')).map(
      (node) => node.textContent,
    );

    // A round ceiling at or above the day's peak, plus a zero baseline.
    expect(svgText).toContain('100 mL');
    expect(svgText).toContain('0 mL');
    // And hours, so the horizontal position is readable too.
    expect(svgText.filter((text) => text?.match(/AM|PM/))).toHaveLength(5);
  });

  it('scales to a round number above the peak rather than to the tallest bar', () => {
    const { container } = render(
      <OutputChart entries={[{ ...entries[0]!, display: { value: 173, unit: 'mL' } }]} />,
    );
    const svgText = Array.from(container.querySelectorAll('svg text')).map(
      (node) => node.textContent,
    );
    // 200, not 173: an axis that reads in human steps.
    expect(svgText).toContain('200 mL');
  });
});
