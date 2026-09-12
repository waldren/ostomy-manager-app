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

import { Button } from './Button.js';

describe('Button', () => {
  it('defaults to type="button" so it never submits an enclosing form implicitly', () => {
    render(<Button>Save entry</Button>);
    expect(screen.getByRole('button', { name: 'Save entry' })).toHaveAttribute('type', 'button');
  });

  it('is keyboard-operable and invokes onClick', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Save entry</Button>);

    const button = screen.getByRole('button', { name: 'Save entry' });
    button.focus();
    expect(button).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('carries the shared focus-visible class for a visible keyboard focus indicator', () => {
    render(<Button>Save entry</Button>);
    expect(screen.getByRole('button')).toHaveClass('ostomyFocusable');
  });

  it('respects the disabled attribute', () => {
    render(<Button disabled>Save entry</Button>);
    expect(screen.getByRole('button', { name: 'Save entry' })).toBeDisabled();
  });
});
