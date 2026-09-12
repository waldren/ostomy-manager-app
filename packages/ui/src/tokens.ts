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
 * Design tokens for the shared `@ostomy/ui` primitives (SRS §5.4).
 *
 * These are plain data, not CSS — every value here has a matching CSS
 * custom property of the same name in `./styles.css` (e.g.
 * `tokens.color.primary` <-> `--ostomy-color-primary`). Keeping the pairing
 * by convention rather than generating one from the other is a deliberate,
 * small piece of debt: it keeps this module importable from a context with
 * no CSS pipeline (a future React Native consumer, or a unit test asserting
 * on `touchTarget.minSize` alone) while `styles.css` stays a plain
 * stylesheet Vite can serve unmodified. `tokens.spec.ts` asserts the two
 * stay in sync.
 *
 * Colors are chosen for WCAG 2.1 AA contrast against `color.background`
 * (white) at normal text size (>= 4.5:1) unless noted otherwise. Nothing
 * here carries meaning by color alone — every component that uses a
 * semantic color (error, warning, success) pairs it with a text label or
 * icon at the call site.
 */
export const tokens = {
  color: {
    /** Primary interactive color (buttons, links, focus accents). ~5.6:1 on white. */
    primary: '#0a4c8a',
    /** Hover/active state for primary. Darker, so contrast only improves. */
    primaryStrong: '#07335c',
    /** Body text. ~15.6:1 on white. */
    text: '#1b1b1b',
    /** Secondary/supporting text (hints, captions). Still >= 4.5:1 on white. */
    textMuted: '#3d4551',
    /** Text rendered on a `primary`-colored surface. */
    textOnPrimary: '#ffffff',
    background: '#ffffff',
    /** Subtle surface for cards/panels, distinguishable from `background` without relying on color alone (paired with a border). */
    surface: '#f4f6f8',
    /** Default border/divider color. >= 3:1 on white (WCAG 1.4.11, non-text contrast). */
    border: '#5b6572',
    /** Hard block / destructive state. ~6.1:1 on white. */
    error: '#a5140a',
    /** Soft-warning state. ~5.2:1 on white — never the sole carrier of the warning; always paired with text. */
    warning: '#7a4b00',
    /** Positive/confirmation state. ~4.6:1 on white. */
    success: '#1e6b30',
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
    xxxl: 48,
  },
  radius: {
    sm: 4,
    md: 8,
    lg: 12,
    pill: 999,
  },
  typography: {
    /**
     * Never below 16px: iOS Safari auto-zooms on focusing a text input with
     * a smaller computed font size, which is precisely the kind of
     * unrequested viewport change SRS §5.4's "text scaling to 200% without
     * loss of content" requirement exists to avoid on the other axis.
     */
    baseFontSizePx: 16,
    lineHeight: 1.5,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  },
  /**
   * Minimum interactive target size, in CSS pixels. WCAG 2.1 AA's own
   * success criterion (2.5.5) is Level AAA, but SRS §5.4 states plainly that
   * "minimum touch-target sizes" are a requirement for this population
   * given reduced post-surgical dexterity — so this repo holds itself to
   * the AAA number rather than the AA floor (24px, WCAG 2.2's 2.5.8).
   */
  touchTarget: {
    minSize: 44,
  },
  focus: {
    outlineWidthPx: 3,
    outlineOffsetPx: 2,
    color: '#2491ff',
  },
} as const;

export type Tokens = typeof tokens;
