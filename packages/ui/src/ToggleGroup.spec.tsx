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
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { ToggleGroup } from './ToggleGroup.js';

function ControlledToggleGroup() {
  const [value, setValue] = useState<'measured' | 'estimated' | undefined>(undefined);
  return (
    <ToggleGroup
      name="method"
      legend="Was this measured or estimated?"
      options={[
        { value: 'measured', label: 'Measured' },
        { value: 'estimated', label: 'Estimated' },
      ]}
      value={value}
      onChange={setValue}
      required
    />
  );
}

describe('ToggleGroup', () => {
  it('groups options under one accessible legend', () => {
    render(<ControlledToggleGroup />);
    expect(screen.getByRole('group', { name: 'Was this measured or estimated?' })).toBeVisible();
  });

  it('every option renders visible text, never an icon-only control (AC 2.2 AC2)', () => {
    render(<ControlledToggleGroup />);
    expect(screen.getByRole('radio', { name: 'Measured' })).toBeVisible();
    expect(screen.getByRole('radio', { name: 'Estimated' })).toBeVisible();
  });

  it('is operable by keyboard and reports the selected value', async () => {
    const user = userEvent.setup();
    render(<ControlledToggleGroup />);

    const measured = screen.getByRole('radio', { name: 'Measured' });
    await user.click(measured);

    expect(measured).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Estimated' })).not.toBeChecked();
  });

  it('surfaces a required-field error through aria-describedby, per AC 2.2 AC1', () => {
    render(
      <ToggleGroup
        name="method"
        legend="Was this measured or estimated?"
        options={[
          { value: 'measured', label: 'Measured' },
          { value: 'estimated', label: 'Estimated' },
        ]}
        value={undefined}
        onChange={() => {}}
        required
        error="Choose Measured or Estimated before saving"
      />,
    );

    expect(screen.getByRole('group')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Choose Measured or Estimated before saving',
    );
  });
});
