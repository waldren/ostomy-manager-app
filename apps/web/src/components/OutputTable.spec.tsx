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
import { OutputTable } from './OutputTable.js';

const entries: readonly DisplayOutputEntry[] = [
  {
    id: 'a',
    effectiveDateTime: new Date('2026-09-11T08:00:00.000Z'),
    display: { value: 100, unit: 'mL' },
    method: 'measured',
  },
  {
    id: 'b',
    effectiveDateTime: new Date('2026-09-11T14:00:00.000Z'),
    display: { value: 150, unit: 'mL' },
    method: 'estimated',
  },
];

describe('OutputTable', () => {
  it("renders one row per entry with a caption, so it stands alone as the chart's accessible data equivalent", () => {
    render(<OutputTable entries={entries} total={{ value: 250, unit: 'mL' }} />);
    expect(screen.getByRole('table')).toHaveAccessibleName(
      'Stoma output entries for the selected day, earliest first',
    );
    expect(screen.getAllByRole('row')).toHaveLength(1 + entries.length + 1); // header + entries + total
  });

  it('shows the Measured/Estimated badge for each entry', () => {
    render(<OutputTable entries={entries} total={{ value: 250, unit: 'mL' }} />);
    expect(screen.getByText('Measured')).toBeVisible();
    expect(screen.getByText('Estimated')).toBeVisible();
  });

  it('renders the total in a footer row, distinctly labelled from a per-entry value', () => {
    render(<OutputTable entries={entries} total={{ value: 250, unit: 'mL' }} />);
    expect(screen.getByText('Total stoma output for this day')).toBeVisible();
  });
});
