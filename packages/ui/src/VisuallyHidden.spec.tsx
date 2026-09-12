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

import { VisuallyHidden } from './VisuallyHidden.js';

describe('VisuallyHidden', () => {
  it('keeps the content in the accessibility tree while visually hiding it', () => {
    render(<VisuallyHidden>Chart data as a table follows</VisuallyHidden>);
    const node = screen.getByText('Chart data as a table follows');
    expect(node).toBeInTheDocument();
    expect(node).toHaveClass('ostomyVisuallyHidden');
  });
});
