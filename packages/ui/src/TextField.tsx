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

import type { InputHTMLAttributes, ReactNode } from 'react';

export interface TextFieldProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'className' | 'id'
> {
  /** Required: the label's `htmlFor` and the input's `id` are derived from it, so the association is structural, not something a caller can forget. */
  readonly id: string;
  readonly label: ReactNode;
  /** Supplementary guidance, not the accessible name itself. */
  readonly hint?: ReactNode;
  /**
   * Validation error text. When present, the field is marked
   * `aria-invalid` and the error is joined into `aria-describedby` — so an
   * error is never conveyed by border colour alone (CLAUDE.md, WCAG 1.4.1).
   */
  readonly error?: ReactNode;
}

/**
 * A labelled text input with an accessible name tied to its label via
 * `htmlFor`/`id`, and hint/error text linked through `aria-describedby`
 * rather than proximity alone.
 */
export function TextField({ id, label, hint, error, required, ...rest }: TextFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="ostomyField">
      <label className="ostomyField__label" htmlFor={id}>
        {label}
      </label>
      {hint ? (
        <span id={hintId} className="ostomyField__hint">
          {hint}
        </span>
      ) : null}
      <input
        id={id}
        className="ostomyField__input ostomyFocusable"
        required={required}
        aria-required={required || undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
      {error ? (
        <span id={errorId} className="ostomyField__error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
