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

  it('uses role="alert" for an assertive notice, so the role agrees with the politeness', () => {
    // The defect: every live notice was role="status", whose implicit live
    // value is `polite`. An assertive notice therefore shipped
    // role="status" + aria-live="assertive" — a combination ARIA leaves
    // undefined and screen readers resolve inconsistently. Where the role
    // wins, a validation error or safety prompt is announced politely and
    // queues behind whatever is already speaking.
    render(
      <InlineNotice variant="error" live="assertive">
        Enter a volume greater than zero.
      </InlineNotice>,
    );

    const notice = screen.getByRole('alert');
    expect(notice).toHaveAttribute('aria-live', 'assertive');
    // Not merely "some other role": specifically not the polite one.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('does not add a live region role when live is unset', () => {
    render(<InlineNotice variant="info">Just context.</InlineNotice>);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
