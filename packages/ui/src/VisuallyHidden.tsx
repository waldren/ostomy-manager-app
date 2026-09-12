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

import type { ElementType, ReactNode } from 'react';

export interface VisuallyHiddenProps {
  readonly children: ReactNode;
  /** Defaults to `span`; pass `'div'` when a block-level wrapper is needed. */
  readonly as?: ElementType;
}

/**
 * Renders content that is present for assistive technology but not visible
 * on screen — for example a table caption or a chart's long-form text
 * description that would be visually redundant next to the chart itself.
 * Never the only way a piece of information reaches a sighted user; use it
 * to add context for screen-reader users, not to hide content from anyone.
 */
export function VisuallyHidden({ children, as: Component = 'span' }: VisuallyHiddenProps) {
  return <Component className="ostomyVisuallyHidden">{children}</Component>;
}
