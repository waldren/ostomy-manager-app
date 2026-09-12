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

/**
 * Small decorative glyphs, always `aria-hidden` and always paired with a
 * visible text label at the call site (e.g. `Badge`'s `icon` prop) — never
 * the sole carrier of meaning (CLAUDE.md, WCAG 1.4.1). No text content, so
 * nothing here is subject to the i18n no-literal-string rule.
 */
import type { SVGProps } from 'react';

type IconProps = Omit<SVGProps<SVGSVGElement>, 'aria-hidden'>;

/** A ruler glyph, used to denote a measured (as opposed to estimated) reading. */
export function MeasuredIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      {...props}
    >
      <rect x="2" y="7" width="16" height="6" rx="1" />
      <path d="M5 7v2M8 7v3M11 7v2M14 7v3" />
    </svg>
  );
}

/** A pencil glyph, used to denote an estimated (as opposed to measured) reading. */
export function EstimatedIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      {...props}
    >
      <path d="M3 17l1-4 9-9 3 3-9 9-4 1z" />
      <path d="M12 5l3 3" />
    </svg>
  );
}

/** A triangular caution glyph, used alongside warning/empty-state notices. */
export function NoticeIcon(props: IconProps) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      {...props}
    >
      <path d="M10 3l8 14H2z" strokeLinejoin="round" />
      <path d="M10 8v4" strokeLinecap="round" />
      <circle cx="10" cy="14.5" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
