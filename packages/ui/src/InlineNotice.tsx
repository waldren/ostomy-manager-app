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

export type InlineNoticeVariant = 'info' | 'warning' | 'error' | 'success';

export interface InlineNoticeProps {
  readonly variant?: InlineNoticeVariant;
  readonly title?: ReactNode;
  readonly icon?: ReactNode;
  readonly children: ReactNode;
  /**
   * `'polite'` announces the notice without interrupting; `'assertive'` is
   * for validation errors and safety prompts. Never set for a purely
   * decorative/status notice — announcing every render is disruptive.
   */
  readonly live?: 'polite' | 'assertive';
}

/**
 * A bordered, iconable notice for empty states, validation warnings, and
 * explanatory banners (e.g. "Daily Net Fluid Balance is not shown yet").
 * The border colour is never the only signal of the notice's severity —
 * pair `variant` with a `title` or body text that says so in words.
 */
export function InlineNotice({ variant = 'info', title, icon, children, live }: InlineNoticeProps) {
  return (
    <div
      className={`ostomyInlineNotice ostomyInlineNotice--${variant}`}
      role={live ? 'status' : undefined}
      aria-live={live}
    >
      {icon ? <span className="ostomyInlineNotice__icon">{icon}</span> : null}
      <div className="ostomyInlineNotice__body">
        {title ? <p className="ostomyInlineNotice__title">{title}</p> : null}
        {children}
      </div>
    </div>
  );
}
