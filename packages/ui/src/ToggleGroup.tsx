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

  return (
    <fieldset
      className="ostomyToggleGroup"
      aria-required={required || undefined}
      aria-invalid={error ? true : undefined}
      aria-describedby={errorId}
    >
      <legend className="ostomyToggleGroup__legend">{legend}</legend>
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
