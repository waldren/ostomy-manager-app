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
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DateNav } from './DateNav.js';

describe('DateNav', () => {
  it('moves to the previous day', async () => {
    const onChangeDate = vi.fn();
    const user = userEvent.setup();
    render(<DateNav isoDate="2026-09-11" onChangeDate={onChangeDate} />);

    await user.click(screen.getByRole('button', { name: 'Show the previous day' }));

    expect(onChangeDate).toHaveBeenCalledWith('2026-09-10');
  });

  it('disables the next-day control when the selected date is today, and never navigates into the future', () => {
    const today = new Date().toISOString().slice(0, 10);
    render(<DateNav isoDate={today} onChangeDate={() => {}} />);
    expect(screen.getByRole('button', { name: 'Show the next day' })).toBeDisabled();
  });

  it('enables the next-day control for a past date', async () => {
    const onChangeDate = vi.fn();
    const user = userEvent.setup();
    render(<DateNav isoDate="2020-01-01" onChangeDate={onChangeDate} />);

    const nextButton = screen.getByRole('button', { name: 'Show the next day' });
    expect(nextButton).toBeEnabled();
    await user.click(nextButton);
    expect(onChangeDate).toHaveBeenCalledWith('2020-01-02');
  });
});
