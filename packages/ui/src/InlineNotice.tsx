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
  /**
   * What element the `title` renders as. `'p'` by default, so no existing
   * call site changes.
   *
   * Pass a heading level when the notice is a SECTION of the page rather than
   * a transient status — a named region a reader would expect to find in the
   * document outline. Heading navigation is how a screen-reader user skims a
   * data page, and a bold paragraph is invisible to it (WCAG 1.3.1, 2.4.6):
   * `apps/web`'s physician view carried two whole data regions — the daily
   * net fluid balance and urine output — that a clinician could not reach or
   * enumerate that way.
   *
   * Styling does not change with it; `ostomyInlineNotice__title` still
   * carries the weight and size, so a heading here does not inherit the
   * page's `h2` scale.
   */
  readonly titleAs?: 'h2' | 'h3' | 'p';
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
export function InlineNotice({
  variant = 'info',
  title,
  titleAs: TitleTag = 'p',
  icon,
  children,
  live,
}: InlineNoticeProps) {
  return (
    <div
      className={`ostomyInlineNotice ostomyInlineNotice--${variant}`}
      /*
        The role must AGREE with the politeness, not contradict it.

        Every live notice was `role="status"`, whose implicit live value is
        `polite` — so an assertive notice shipped `role="status"` with
        `aria-live="assertive"`, a combination ARIA does not define a winner
        for. Real screen readers disagree about it: some honour the explicit
        attribute, others take the role's implicit value and announce
        politely, and a politely-announced validation error waits behind
        whatever is already speaking. The pairing below is the one each role
        already implies, so there is nothing left to resolve.
      */
      role={live === 'assertive' ? 'alert' : live ? 'status' : undefined}
      aria-live={live}
    >
      {icon ? <span className="ostomyInlineNotice__icon">{icon}</span> : null}
      <div className="ostomyInlineNotice__body">
        {title ? <TitleTag className="ostomyInlineNotice__title">{title}</TitleTag> : null}
        {children}
      </div>
    </div>
  );
}
