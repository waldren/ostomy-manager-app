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

export interface ToggleGroupOption<TValue extends string> {
  readonly value: TValue;
  readonly label: ReactNode;
}

export interface ToggleGroupProps<TValue extends string> {
  readonly name: string;
  readonly legend: ReactNode;
  readonly options: ReadonlyArray<ToggleGroupOption<TValue>>;
  readonly value: TValue | undefined;
  readonly onChange: (value: TValue) => void;
  readonly required?: boolean;
  /** e.g. the "required field" message for AC 2.2 AC1 (SRS §7) when no option was selected. */
  readonly error?: ReactNode;
}

/**
 * A single-select group of visible, always-labelled options — e.g. the
 * mandatory Measured/Estimated toggle (SRS §3.1, AC 2.2). Built from native
 * `<fieldset>`/`<legend>`/radio inputs rather than a custom widget, so
 * keyboard operation (arrow-key roving within the group, Tab in/out) and
 * screen-reader semantics come from the browser rather than being
 * reimplemented. Each option always renders its own visible text label —
 * this is not an icon-only control — so selection state is never conveyed
 * by colour alone.
 */
export function ToggleGroup<TValue extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  required,
  error,
}: ToggleGroupProps<TValue>) {
  const errorId = error ? `${name}-error` : undefined;

  const legendId = `${name}-legend`;

  return (
    // `role="radiogroup"`, not the bare `<fieldset>` default of `role="group"`.
    //
    // ARIA 1.2 scopes `aria-required` and `aria-invalid` to widget roles;
    // neither is supported on `role="group"`, so both were silently dropped
    // from the accessibility tree. The mandatory Measured/Estimated error
    // (SRS AC 2.2 AC 1) was highlighted visually and never announced — and
    // `role="alert"` on the message below only covers a DYNAMIC insertion,
    // so it did nothing when a caller re-rendered with the error already
    // present. That is the ordinary case here, not an edge one: an offline
    // queued operation rejected server-side is surfaced for correction with
    // its error already set (AC 13.1 AC 4).
    //
    // `aria-labelledby` is explicit because a `radiogroup` does not take its
    // name from `<legend>` the way a native `<fieldset>` does.
    <fieldset
      className="ostomyToggleGroup"
      role="radiogroup"
      aria-labelledby={legendId}
      aria-required={required || undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={errorId}
    >
      <legend id={legendId} className="ostomyToggleGroup__legend">
        {legend}
      </legend>
      <div className="ostomyToggleGroup__options">
        {options.map((option) => {
          const optionId = `${name}-${option.value}`;
          return (
            <label key={option.value} className="ostomyToggleGroup__option" htmlFor={optionId}>
              <input
                id={optionId}
                className="ostomyToggleGroup__radio ostomyFocusable"
                type="radio"
                name={name}
                value={option.value}
                checked={value === option.value}
                onChange={() => onChange(option.value)}
                // Also on each radio, not only on the group. NVDA and JAWS
                // announce group-level descriptions inconsistently when focus
                // lands on a child radio, and the error text is precisely the
                // instruction the user needs at the moment they arrive to fix
                // it.
                aria-describedby={errorId}
              />
              {option.label}
            </label>
          );
        })}
      </div>
      {error ? (
        <span id={errorId} className="ostomyField__error" role="alert">
          {error}
        </span>
      ) : null}
    </fieldset>
  );
}
