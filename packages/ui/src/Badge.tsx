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

import type { ReactNode } from 'react';

export type BadgeVariant = 'neutral' | 'info' | 'warning';

export interface BadgeProps {
  readonly variant?: BadgeVariant;
  /**
   * A decorative icon rendered alongside the text. It must never be the
   * only thing distinguishing one badge from another — `children` (visible
   * text) is required precisely so a state like Measured/Estimated
   * (AC 2.2 AC2, SRS §7) is never conveyed by icon or colour alone. Pass an
   * `aria-hidden="true"` SVG or similar; this component does not add that
   * attribute for you because it has no opinion on the icon's markup.
   */
  readonly icon?: ReactNode;
  readonly children: ReactNode;
}

/**
 * A small labelled status indicator. Always renders visible text — see the
 * `icon` prop's doc comment for why `children` is mandatory rather than
 * optional.
 */
export function Badge({ variant = 'neutral', icon, children }: BadgeProps) {
  return (
    <span className={`ostomyBadge ostomyBadge--${variant}`}>
      {icon ? <span className="ostomyBadge__icon">{icon}</span> : null}
      {children}
    </span>
  );
}
