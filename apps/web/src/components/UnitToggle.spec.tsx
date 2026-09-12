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

import { UnitToggle } from './UnitToggle.js';

describe('UnitToggle', () => {
  it('offers metric and imperial as visibly labelled options', () => {
    render(<UnitToggle value="metric" onChange={() => {}} />);
    expect(screen.getByRole('radio', { name: 'Milliliters (mL)' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Fluid ounces (oz)' })).not.toBeChecked();
  });

  it('reports the selected system on change', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<UnitToggle value="metric" onChange={onChange} />);

    await user.click(screen.getByRole('radio', { name: 'Fluid ounces (oz)' }));

    expect(onChange).toHaveBeenCalledWith('imperial');
  });
});
