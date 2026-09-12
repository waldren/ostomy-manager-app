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

describe('design tokens stay in sync with styles.css', () => {
  it.each([
    ['color-primary', tokens.color.primary],
    ['color-primary-strong', tokens.color.primaryStrong],
    ['color-text', tokens.color.text],
    ['color-text-muted', tokens.color.textMuted],
    ['color-text-on-primary', tokens.color.textOnPrimary],
    ['color-background', tokens.color.background],
    ['color-surface', tokens.color.surface],
    ['color-border', tokens.color.border],
    ['color-error', tokens.color.error],
    ['color-warning', tokens.color.warning],
    ['color-success', tokens.color.success],
  ])('color custom property --ostomy-%s matches tokens.ts', (name, value) => {
    expect(cssCustomProperty(name).toLowerCase()).toBe(value.toLowerCase());
  });

  it.each([
    ['space-xs', tokens.spacing.xs],
    ['space-sm', tokens.spacing.sm],
    ['space-md', tokens.spacing.md],
    ['space-lg', tokens.spacing.lg],
    ['space-xl', tokens.spacing.xl],
    ['space-xxl', tokens.spacing.xxl],
    ['space-xxxl', tokens.spacing.xxxl],
  ])('spacing custom property --ostomy-%s matches tokens.ts', (name, value) => {
    expect(cssCustomProperty(name)).toBe(`${value}px`);
  });

  it.each([
    ['radius-sm', tokens.radius.sm],
    ['radius-md', tokens.radius.md],
    ['radius-lg', tokens.radius.lg],
    ['radius-pill', tokens.radius.pill],
  ])('radius custom property --ostomy-%s matches tokens.ts', (name, value) => {
    expect(cssCustomProperty(name)).toBe(`${value}px`);
  });

  it('touch-target minimum matches tokens.ts', () => {
    expect(cssCustomProperty('touch-target-min')).toBe(`${tokens.touchTarget.minSize}px`);
  });

  it('focus ring values match tokens.ts', () => {
    expect(cssCustomProperty('focus-width')).toBe(`${tokens.focus.outlineWidthPx}px`);
    expect(cssCustomProperty('focus-offset')).toBe(`${tokens.focus.outlineOffsetPx}px`);
    expect(cssCustomProperty('focus-color-inner').toLowerCase()).toBe(
      tokens.focus.colorInner.toLowerCase(),
    );
    expect(cssCustomProperty('focus-color-outer').toLowerCase()).toBe(
      tokens.focus.colorOuter.toLowerCase(),
    );
  });

  it('typography values match tokens.ts', () => {
    expect(cssCustomProperty('font-size-base')).toBe(`${tokens.typography.baseFontSizePx}px`);
    expect(cssCustomProperty('line-height')).toBe(String(tokens.typography.lineHeight));
    expect(cssCustomProperty('font-family')).toBe(tokens.typography.fontFamily);
  });
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

  it('the inner focus tone clears 3:1 on both page surfaces', () => {
    expect(contrastRatio(tokens.focus.colorInner, background)).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(tokens.focus.colorInner, surface)).toBeGreaterThanOrEqual(3);
  });
});
