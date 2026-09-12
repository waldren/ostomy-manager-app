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

export interface SkipLinkProps {
  /** The id of the page's main landmark, without the leading `#`. */
  readonly targetId: string;
  /** Visible link text once focused. Supplied by the caller — no default copy lives here (ADR-0006). */
  readonly children: ReactNode;
}

/**
 * A "skip to main content" link (WCAG 2.4.1). Offscreen until it receives
 * keyboard focus, at which point it reappears in the normal document flow
 * — see `.ostomySkipLink` in `./styles.css`. Web-only: React Native has no
 * document flow for this pattern to apply to.
 */
export function SkipLink({ targetId, children }: SkipLinkProps) {
  return (
    <a className="ostomySkipLink ostomyFocusable" href={`#${targetId}`}>
      {children}
    </a>
  );
}
