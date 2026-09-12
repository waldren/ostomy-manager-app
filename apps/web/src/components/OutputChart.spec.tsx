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

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DisplayOutputEntry } from '../format/formatObservationsForDisplay.js';
import { OutputChart } from './OutputChart.js';

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
    render(<OutputChart entries={entries} />);
    // The visually-hidden long description carries the same data the bars encode.
    expect(screen.getByText(/100/)).toBeInTheDocument();
  });

  it('states the axis labels and units in visible text, not only implied by the picture', () => {
    render(<OutputChart entries={entries} />);
    expect(screen.getByText('Output volume')).toBeVisible();
    expect(screen.getByText('Time of day')).toBeVisible();
  });
});
