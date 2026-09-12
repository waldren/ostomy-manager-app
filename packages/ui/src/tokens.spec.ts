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
    expect(cssCustomProperty('focus-color').toLowerCase()).toBe(tokens.focus.color.toLowerCase());
  });

  it('typography values match tokens.ts', () => {
    expect(cssCustomProperty('font-size-base')).toBe(`${tokens.typography.baseFontSizePx}px`);
    expect(cssCustomProperty('line-height')).toBe(String(tokens.typography.lineHeight));
    expect(cssCustomProperty('font-family')).toBe(tokens.typography.fontFamily);
  });
});
