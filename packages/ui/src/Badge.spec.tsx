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

import { Badge } from './Badge.js';
import { EstimatedIcon, MeasuredIcon } from './icons.js';

describe('Badge', () => {
  it('always renders visible text, not only an icon (AC 2.2 AC2 — never colour/icon alone)', () => {
    render(
      <Badge variant="neutral" icon={<MeasuredIcon />}>
        Measured
      </Badge>,
    );
    expect(screen.getByText('Measured')).toBeVisible();
  });

  it('hides the decorative icon from assistive technology', () => {
    const { container } = render(
      <Badge variant="info" icon={<EstimatedIcon />}>
        Estimated
      </Badge>,
    );
    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
  });

  it('renders without an icon when none is supplied', () => {
    render(<Badge>Neutral</Badge>);
    expect(screen.getByText('Neutral')).toBeVisible();
  });
});
