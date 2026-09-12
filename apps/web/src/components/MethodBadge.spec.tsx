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

import { MethodBadge } from './MethodBadge.js';

describe('MethodBadge — AC 2.2 AC2 visual differentiation in history', () => {
  it('shows visible "Measured" text, not only an icon or colour', () => {
    render(<MethodBadge method="measured" />);
    expect(screen.getByText('Measured')).toBeVisible();
  });

  it('shows visible "Estimated" text, not only an icon or colour', () => {
    render(<MethodBadge method="estimated" />);
    expect(screen.getByText('Estimated')).toBeVisible();
  });

  it('uses a different icon for each state so the distinction is not colour-only', () => {
    const { container: measuredContainer } = render(<MethodBadge method="measured" />);
    const { container: estimatedContainer } = render(<MethodBadge method="estimated" />);
    expect(measuredContainer.querySelector('svg')?.outerHTML).not.toBe(
      estimatedContainer.querySelector('svg')?.outerHTML,
    );
  });
});
