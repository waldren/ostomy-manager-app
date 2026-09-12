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

import { DailyBalanceNotice } from './DailyBalanceNotice.js';

describe('DailyBalanceNotice — Daily Net Fluid Balance renders as explicitly incomplete', () => {
  it('states plainly that the figure is not shown, rather than rendering any number', () => {
    render(<DailyBalanceNotice />);
    expect(screen.getByText('Daily net fluid balance: not shown')).toBeVisible();
    // The substantive claim: it says WHY there is no number and what to read
    // instead, rather than just omitting the figure.
    expect(screen.getByText(/does not record fluid intake yet/i)).toBeVisible();
    expect(screen.getByText(/only one side of the balance/i)).toBeVisible();
  });

  it('never renders a numeric balance value', () => {
    render(<DailyBalanceNotice />);
    // A real balance would render as a number-unit pair (e.g. "250 mL"); the
    // explanatory copy above intentionally contains none.
    expect(screen.queryByText(/\d+\s?(mL|oz)/)).not.toBeInTheDocument();
  });
});
