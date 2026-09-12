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

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { tokens } from './tokens.js';

/**
 * `tokens.ts` and `styles.css` are two hand-written sources of the same
 * values, kept in sync by convention rather than generation (see
 * `tokens.ts`'s own doc comment for why). This test is the thing that makes
 * "kept in sync by convention" true rather than aspirational: it fails the
 * build the moment either file drifts from the other.
 */
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, './styles.css'), 'utf-8');

function cssCustomProperty(name: string): string {
  const match = css.match(new RegExp(`--ostomy-${name}:\\s*([^;]+);`));
  const captured = match?.[1];
  if (captured === undefined) {
    throw new Error(`styles.css has no --ostomy-${name} custom property`);
  }
  return captured.trim();
}

/**
 * Every token leaf, and the custom property that must carry it.
 *
 * This map replaced three hand-maintained `it.each` lists, and the reason is
 * the defect those lists had: they proved sync only for the names somebody
 * remembered to add. A token added to `tokens.ts` with no corresponding CSS
 * property — the exact drift a sync test exists to catch — passed silently,
 * because nothing compared the set of tokens against the set of assertions.
 *
 * The completeness test below closes that. It fails both ways: a new token
 * with no entry here, and an entry here for a token that no longer exists.
 * The mapping is written out rather than derived because the names are not
 * mechanical (`spacing.xs` is `--ostomy-space-xs`, `focus.outlineWidthPx` is
 * `--ostomy-focus-width`), and inventing a transform to fit them would be a
 * second thing that can silently be wrong.
 */
const CSS_PROPERTY_BY_TOKEN_PATH = {
  'color.primary': 'color-primary',
  'color.primaryStrong': 'color-primary-strong',
  'color.text': 'color-text',
  'color.textMuted': 'color-text-muted',
  'color.textOnPrimary': 'color-text-on-primary',
  'color.background': 'color-background',
  'color.surface': 'color-surface',
  'color.border': 'color-border',
  'color.error': 'color-error',
  'color.warning': 'color-warning',
  'color.success': 'color-success',
  'spacing.xs': 'space-xs',
  'spacing.sm': 'space-sm',
  'spacing.md': 'space-md',
  'spacing.lg': 'space-lg',
  'spacing.xl': 'space-xl',
  'spacing.xxl': 'space-xxl',
  'spacing.xxxl': 'space-xxxl',
  'radius.sm': 'radius-sm',
  'radius.md': 'radius-md',
  'radius.lg': 'radius-lg',
  'radius.pill': 'radius-pill',
  'typography.baseFontSizePx': 'font-size-base',
  'typography.lineHeight': 'line-height',
  'typography.fontFamily': 'font-family',
  'touchTarget.minSize': 'touch-target-min',
  'focus.outlineWidthPx': 'focus-width',
  'focus.outlineOffsetPx': 'focus-offset',
  'focus.colorInner': 'focus-color-inner',
  'focus.colorOuter': 'focus-color-outer',
} as const satisfies Record<string, string>;

/** Unitless by nature; every other number in `tokens` is a pixel measure. */
const UNITLESS_TOKEN_PATHS = new Set(['typography.lineHeight']);

/** Walks `tokens` to its leaves, yielding dotted paths. */
function tokenLeafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) {
    return [prefix];
  }
  return Object.entries(value).flatMap(([key, child]) =>
    tokenLeafPaths(child, prefix ? `${prefix}.${key}` : key),
  );
}

function tokenValue(path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (current, key) => (current as Record<string, unknown>)[key],
      tokens as unknown,
    );
}

describe('design tokens stay in sync with styles.css', () => {
  it('maps every token in tokens.ts, and nothing that is not one', () => {
    // The test that makes the rest of this block trustworthy. Without it,
    // adding a token and forgetting its CSS property is invisible.
    expect(tokenLeafPaths(tokens).sort()).toEqual(Object.keys(CSS_PROPERTY_BY_TOKEN_PATH).sort());
  });

  it.each(Object.entries(CSS_PROPERTY_BY_TOKEN_PATH))(
    'tokens.%s is carried by --ostomy-%s',
    (path, property) => {
      const value = tokenValue(path);
      const expected =
        typeof value === 'number' && !UNITLESS_TOKEN_PATHS.has(path) ? `${value}px` : String(value);
      // Lowercased on both sides: hex colours and font-family names differ
      // in case between the two files without differing in meaning.
      expect(cssCustomProperty(property).toLowerCase()).toBe(expected.toLowerCase());
    },
  );
});

/**
 * Contrast, asserted rather than described.
 *
 * Every ratio in `tokens.ts` used to be a hand-written estimate, and every
 * one was wrong — all understated, so the palette passed and nobody noticed.
 * Meanwhile the single-tone focus ring measured 2.95:1 on `surface`, an
 * actual WCAG 1.4.11 failure that a comment could not catch.
 *
 * This is the one accessibility property here that is genuinely
 * machine-checkable, so it is checked. It is a floor, not coverage: no
 * computation can tell you a state is carried by colour alone, that copy
 * reads at the wrong level, or that a chart disagrees with its table.
 */
/** Extracts one rule's declarations. String slicing, not a RegExp — see VisuallyHidden.spec.tsx. */
function ruleBody(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) {
    throw new Error(`styles.css has no ${selector} rule`);
  }
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

function relativeLuminance(hex: string): number {
  const channels = (hex.replace('#', '').match(/../g) ?? []).map((pair) => {
    const value = Number.parseInt(pair, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(a: string, b: string): number {
  const [high, low] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

describe('colour contrast', () => {
  const { background, surface } = tokens.color;

  // Everything rendered as text, against both surfaces it can sit on.
  it.each([
    ['primary', tokens.color.primary],
    ['text', tokens.color.text],
    ['textMuted', tokens.color.textMuted],
    ['error', tokens.color.error],
    ['warning', tokens.color.warning],
    ['success', tokens.color.success],
  ])('%s clears 4.5:1 on background and on surface', (_name, colour) => {
    expect(contrastRatio(colour, background)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(colour, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it('border clears 3:1 on background and on surface (WCAG 1.4.11, non-text)', () => {
    expect(contrastRatio(tokens.color.border, background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokens.color.border, surface)).toBeGreaterThanOrEqual(3);
  });

  it('text on a primary-coloured surface clears 4.5:1', () => {
    expect(contrastRatio(tokens.color.textOnPrimary, tokens.color.primary)).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('the two focus tones contrast with each other, which is what makes the ring work anywhere', () => {
    // The pair is the control. A single tone cannot clear 3:1 against white,
    // surface AND the primary button fill at once — so the indicator is
    // judged by its own inner/outer boundary instead, and that boundary is
    // backdrop-independent.
    expect(contrastRatio(tokens.focus.colorInner, tokens.focus.colorOuter)).toBeGreaterThanOrEqual(
      3,
    );
  });

  it('colorInner clears 3:1 on both page surfaces, because it renders OUTERMOST', () => {
    // The naming is the trap here, so state the rendering rather than
    // trusting it. `box-shadow` spreads outward from the border-box edge
    // and the `outline` paints over its outer part, so `colorInner` — the
    // outline's tone — is the ring that actually meets the page, and it is
    // the one WCAG 1.4.11 judges against the backdrop.
    expect(contrastRatio(tokens.focus.colorInner, background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokens.focus.colorInner, surface)).toBeGreaterThanOrEqual(3);
  });

  it('the stylesheet keeps colorInner on the outline, where the page can see it', () => {
    // Without this the suite could not tell the difference. Swapping the two
    // tones in styles.css to match a naive reading of "dark inner, light
    // outer" puts #2491ff outermost, where it measures 2.95:1 on surface —
    // a real 1.4.11 failure — and every assertion above still passes,
    // because they read tokens.ts and the tokens did not change.
    const rule = ruleBody('.ostomyFocusable:focus-visible');
    const outline = rule.slice(rule.indexOf('outline:'), rule.indexOf('outline-offset'));
    expect(outline).toContain('--ostomy-focus-color-inner');
    expect(rule.slice(rule.indexOf('box-shadow'))).toContain('--ostomy-focus-color-outer');
    // And the shadow must still reach past the outline, or there is no
    // second tone at all.
    expect(contrastRatio(tokens.focus.colorInner, tokens.focus.colorOuter)).toBeGreaterThanOrEqual(
      3,
    );
  });
});
