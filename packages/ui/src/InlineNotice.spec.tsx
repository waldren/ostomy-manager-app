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

import { InlineNotice } from './InlineNotice.js';

describe('InlineNotice', () => {
  it('renders a title and body', () => {
    render(
      <InlineNotice variant="info" title="Daily balance not shown yet">
        Fluid intake logging is coming in a later release.
      </InlineNotice>,
    );
    expect(screen.getByText('Daily balance not shown yet')).toBeVisible();
    expect(screen.getByText(/fluid intake logging/i)).toBeVisible();
  });

  it('announces politely when live="polite" is set', () => {
    render(
      <InlineNotice variant="success" live="polite">
        Saved.
      </InlineNotice>,
    );
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('does not add a live region role when live is unset', () => {
    render(<InlineNotice variant="info">Just context.</InlineNotice>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
