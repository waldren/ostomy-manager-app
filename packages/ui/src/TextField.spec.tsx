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

import { TextField } from './TextField.js';

describe('TextField', () => {
  it('ties the visible label to the input via htmlFor/id', () => {
    render(<TextField id="volume" label="Output volume (mL)" />);
    expect(screen.getByLabelText('Output volume (mL)')).toBe(screen.getByRole('textbox'));
  });

  it('associates hint text via aria-describedby', () => {
    render(<TextField id="volume" label="Output volume (mL)" hint="Enter a positive number" />);
    const input = screen.getByRole('textbox');
    expect(input).toHaveAccessibleDescription('Enter a positive number');
  });

  it('marks aria-invalid and programmatically associates the error message, not just colour (AC 13.1)', () => {
    render(
      <TextField id="volume" label="Output volume (mL)" error="Enter a number greater than zero" />,
    );
    const input = screen.getByRole('textbox');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a number greater than zero');
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a number greater than zero');
  });

  it('joins hint and error into one aria-describedby when both are present', () => {
    render(
      <TextField
        id="volume"
        label="Output volume (mL)"
        hint="Enter a positive number"
        error="Enter a number greater than zero"
      />,
    );
    const input = screen.getByRole('textbox');
    expect(input.getAttribute('aria-describedby')).toBe('volume-hint volume-error');
  });
});
