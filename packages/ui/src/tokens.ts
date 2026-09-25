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
  /**
   * Swatches for the pale-to-dark urine colour scale (SRS §3.7, AC 12.1).
   *
   * **CONTENT colours, not UI colours.** They depict a real-world
   * appearance rather than expressing state, so the contrast ratios
   * documented on `color` below do not apply and are not claimed for them.
   *
   * They are always DECORATIVE. Every step of the scale carries a visible
   * text label, and the swatch is hidden from assistive technology, so
   * colour is never the sole carrier of meaning (AC 12.1 AC3, SRS §5.4).
   * A patient who cannot distinguish these still reads the same scale.
   *
   * Keyed by `urine_color` value-set member code. A member an admin adds
   * later has no swatch here and renders without one rather than with a
   * wrong one.
   */
  /**
   * The pale-to-dark urine colour scale (SRS §3.7, AC 12.1 AC3).
   *
   * CONTENT colours, not palette colours: each one depicts the shade a patient
   * is asked to recognise. Decorative in the strict accessibility sense — every
   * step carries a text label that is the whole distinction, so the swatch is
   * hidden from assistive technology. Never a background behind text, and never
   * the only carrier of a step's identity.
   *
   * ## The 1.4.11 exemption, measured rather than asserted
   *
   * | step | vs `background` | vs `surface` | vs `border` |
   * | --- | --- | --- | --- |
   * | `pale_straw` | 1.11:1 | 1.03:1 | 5.31:1 |
   * | `straw` | 1.21:1 | 1.12:1 | 4.88:1 |
   * | `yellow` | 1.36:1 | 1.26:1 | 4.35:1 |
   * | `dark_yellow` | 1.67:1 | 1.54:1 | 3.54:1 |
   * | `amber` | 2.46:1 | 2.27:1 | 2.41:1 |
   * | `brown` | 4.99:1 | 4.60:1 | 1.19:1 |
   *
   * Adjacent-step pairs: 1.09 / 1.12 / 1.23 / 1.47 / 2.03:1.
   *
   * Three things those numbers establish, in the order they matter:
   *
   * 1. **The exemption is legitimate.** WCAG 1.4.11 exempts a graphical object
   *    "where a particular presentation is essential to the information being
   *    conveyed". `pale_straw` cannot be raised to 3:1 against white without
   *    ceasing to depict pale straw. No fill ratio applies.
   * 2. **The 1px border is what carries 1.4.11, and it does.** `color.border`
   *    is 5.92:1 on `background` and 5.46:1 on `surface`, so the swatch's SHAPE
   *    clears 3:1 on both surfaces at every step, independent of fill.
   * 3. **The border vanishing into the two darkest fills is harmless.** 2.41:1
   *    and 1.19:1 would matter if the border identified the swatch against its
   *    own fill; it identifies it against the SURFACE, and those two fills are
   *    2.46:1 and 4.99:1 against white on their own.
   *
   * The adjacent-pair ratios of 1.09–1.47:1 are why the labels have to be the
   * scale rather than a caption on it: this population's age-related lens
   * yellowing degrades exactly the blue/yellow axis these six live on.
   */
  urineColorSwatch: {
    pale_straw: '#f8f4d2',
    straw: '#f5eba8',
    yellow: '#f2de6a',
    dark_yellow: '#e8c63e',
    amber: '#d79a2b',
    brown: '#9c6318',
  },

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
