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
/*
 * Every ratio quoted below is ASSERTED by `tokens.spec.ts`, not estimated.
 *
 * The previous figures were all wrong — every one understated the real
 * contrast (primary was documented at ~5.6:1 and measures 8.70:1). The
 * palette passed regardless, which is exactly why it went unnoticed: a
 * comment is not a control, and these numbers are the budget a future
 * contributor tunes against. `success` documented at ~4.6:1 reads as having
 * no headroom when it has 6.56:1.
 */
export const tokens = {
  color: {
    /** Primary interactive color (buttons, links). 8.70:1 on white, 8.03:1 on `surface`. */
    primary: '#0a4c8a',
    /** Hover/active state for primary. Darker, so contrast only improves. */
    primaryStrong: '#07335c',
    /** Body text. 17.22:1 on white, 15.90:1 on `surface`. */
    text: '#1b1b1b',
    /** Secondary/supporting text (hints, captions). 9.68:1 on white, 8.94:1 on `surface`. */
    textMuted: '#3d4551',
    /** Text rendered on a `primary`-colored surface. */
    textOnPrimary: '#ffffff',
    background: '#ffffff',
    /** Subtle surface for cards/panels, distinguishable from `background` without relying on color alone (paired with a border). */
    surface: '#f4f6f8',
    /** Default border/divider color. 5.92:1 on white, 5.46:1 on `surface` (WCAG 1.4.11 needs 3:1). */
    border: '#5b6572',
    /** Hard block / destructive state. 7.77:1 on white, 7.17:1 on `surface`. */
    error: '#a5140a',
    /** Soft-warning state. 7.41:1 on white, 6.84:1 on `surface` — never the sole carrier of the warning; always paired with text. */
    warning: '#7a4b00',
    /** Positive/confirmation state. 6.56:1 on white, 6.06:1 on `surface`. */
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
  /**
   * Two tones, not one, and the pair is load-bearing.
   *
   * No single solid colour clears WCAG 1.4.11's 3:1 against white,
   * `surface` AND the primary button's own fill simultaneously — the
   * previous single `#2491ff` measured 3.20:1 on white and **2.95:1 on
   * `surface`**, a fail, and `surface` is exactly where focus lands (the
   * "Try again" button inside an InlineNotice, the selected ToggleGroup
   * option).
   *
   * A dark inner ring against a light outer one contrasts at 5.39:1 with
   * each other, so the indicator is distinguishable from whatever it sits
   * on: wherever one tone is low-contrast against the backdrop, the other
   * is not.
   */
  focus: {
    outlineWidthPx: 3,
    outlineOffsetPx: 2,
    /** 17.22:1 on white, 15.90:1 on `surface`. */
    colorInner: '#1b1b1b',
    /** 5.39:1 against `colorInner`, which is what makes the pair work on any backdrop. */
    colorOuter: '#2491ff',
  },
} as const;

export type Tokens = typeof tokens;
