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

import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'danger';

export interface ButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'className' | 'type'
> {
  readonly children: ReactNode;
  readonly variant?: ButtonVariant;
  /** Defaults to `'button'` — an explicit choice, since an un-typed `<button>` inside a `<form>` submits it. */
  readonly type?: 'button' | 'submit' | 'reset';
  /**
   * Forwarded to the underlying `<button>`.
   *
   * Needed by any pattern that must MOVE focus to a control rather than
   * wait for the user to reach it: a dialog placing focus on its confirm
   * button, an error summary sending focus to the first invalid field's
   * label. React 19 passes `ref` as an ordinary prop, so this needs no
   * `forwardRef` — but it does need declaring, or the prop is a type error
   * at every call site.
   */
  readonly ref?: Ref<HTMLButtonElement>;
}

/**
 * A button styled for a >= 44px touch target (CLAUDE.md, SRS §5.4) with a
 * visible `:focus-visible` ring (`.ostomyFocusable`, WCAG 2.4.7). Carries no
 * copy of its own — `children` is required and supplied by the caller
 * through the i18n catalog (ADR-0006).
 */
export function Button({
  children,
  variant = 'primary',
  type = 'button',
  ref,
  ...rest
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={`ostomyButton ostomyButton--${variant} ostomyFocusable`}
      {...rest}
    >
      {children}
    </button>
  );
}
