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
 * `ChoiceGroup` at a large OS text size (P4.S3 slice 6, the accessibility
 * audit, WCAG 1.4.4).
 *
 * Measured first on a Pixel 8 emulator at the largest Android text size
 * (2.0×): the urine colour scale's labels ran past their option borders, the
 * swatches stuck out on the left, and "Orange-brown" broke mid-word behind the
 * next swatch. jest has no layout engine, so this cannot see that happen; it
 * pins the two style rules that stop it, so neither can be "tidied" away.
 */

import { fireEvent, render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ChoiceGroup, type Choice } from './ChoiceGroup';

let mockFontScale = 1;
jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 411, height: 914, scale: 2.625, fontScale: mockFontScale }),
}));

const CHOICES = [
  { value: 'pale', label: 'Pale yellow', swatchColor: '#F4EBA8' },
  { value: 'orange', label: 'Orange-brown', swatchColor: '#D99A2E' },
] as const;

async function options() {
  const screen = await render(
    <ChoiceGroup label="What colour?" choices={CHOICES} value={undefined} onChange={() => {}} />,
  );
  return screen.getAllByRole('radio').map((option) => StyleSheet.flatten(option.props.style));
}

afterEach(() => {
  mockFontScale = 1;
});

describe('ChoiceGroup at a large OS text size', () => {
  /** Two options share a row at the default size, as before. */
  it('keeps the default width at the default text size', async () => {
    mockFontScale = 1;

    expect((await options()).map((style) => style.flexBasis)).toEqual([140, 140]);
  });

  /**
   * The width grows with the text, so at 2.0× an option needs a whole row and
   * `flexWrap` stacks them one per line instead of squeezing two labels into
   * half a screen each.
   */
  it('scales the width with the text, so the options stack', async () => {
    mockFontScale = 2;

    expect((await options()).map((style) => style.flexBasis)).toEqual([280, 280]);
  });

  /** Never narrower than the default: an OS setting below 1 must not squeeze two labels together. */
  it('does not shrink below the default width', async () => {
    mockFontScale = 0.85;

    expect((await options()).map((style) => style.flexBasis)).toEqual([140, 140]);
  });

  /**
   * #150 review: React Native's `flexShrink` defaults to 0, so a basis scaled
   * for large text could be wider than a narrow screen (a larger "Display
   * size" as well as a larger font) and run off its right edge.
   */
  it('never lets an option grow wider than the row', async () => {
    mockFontScale = 2;

    for (const style of await options()) {
      expect(style.flexShrink).toBe(1);
      expect(style.maxWidth).toBe('100%');
    }
  });

  /** The label gives way by wrapping, and the swatch and mark keep their size. */
  it('lets the label wrap within its option while the swatch and mark keep their size', async () => {
    const screen = await render(
      <ChoiceGroup label="What colour?" choices={CHOICES} value="pale" onChange={() => {}} />,
    );

    const label = StyleSheet.flatten(screen.getByText('Pale yellow').props.style);
    expect(label.flexShrink).toBe(1);
    for (const mark of screen.getAllByText('✓')) {
      expect(StyleSheet.flatten(mark.props.style).flexShrink).toBe(0);
    }
    for (const swatch of screen.getAllByTestId('choice-swatch')) {
      expect(StyleSheet.flatten(swatch.props.style).flexShrink).toBe(0);
    }
  });

  /**
   * #150 review: a mark that appeared only on selection narrowed the label,
   * which could add a line and move the options below under the finger. It
   * now always holds its place, and shows only on the chosen option.
   */
  it('keeps the mark’s space on every option, visible only on the chosen one', async () => {
    const screen = await render(
      <ChoiceGroup label="What colour?" choices={CHOICES} value="pale" onChange={() => {}} />,
    );

    const opacities = screen
      .getAllByText('✓')
      .map((mark) => StyleSheet.flatten(mark.props.style).opacity ?? 1);
    expect(opacities).toEqual([1, 0]);
  });

  /** A colour scale is matched against, so its swatches line up in a column, as on a printed chart. */
  it('lines up swatches and their labels on the left', async () => {
    const screen = await render(
      <ChoiceGroup label="What colour?" choices={CHOICES} value={undefined} onChange={() => {}} />,
    );

    expect(StyleSheet.flatten(screen.getAllByRole('radio')[0]?.props.style).justifyContent).toBe(
      'flex-start',
    );
    expect(StyleSheet.flatten(screen.getByText('Pale yellow').props.style).textAlign).toBe('left');
  });

  /**
   * #150 review, measured at 2.0× text and a larger display size: beside the
   * mark and swatch the label had ~148dp, "Orange-brown" needs ~160, and
   * Android broke it as "Orange-bro / wn". Once the options stack, the swatch
   * goes above the label so the label has the option's whole width.
   */
  async function layoutAt(
    fontScale: number,
    rowWidth: number,
    choices: readonly Choice<string>[] = CHOICES,
  ) {
    mockFontScale = fontScale;
    const screen = await render(
      <ChoiceGroup label="What colour?" choices={choices} value={undefined} onChange={() => {}} />,
    );
    await fireEvent(screen.getByTestId('choice-options'), 'layout', {
      nativeEvent: { layout: { width: rowWidth, height: 400, x: 0, y: 0 } },
    });
    return screen
      .getAllByRole('radio')
      .map((option) => StyleSheet.flatten(option.props.style).flexDirection);
  }

  it('puts the swatch above the label once the options stack', async () => {
    expect(await layoutAt(2, 257)).toEqual(['column', 'column']);
  });

  it('keeps the swatch beside the label while two options share a row', async () => {
    expect(await layoutAt(1, 379)).toEqual(['row', 'row']);
  });

  it('leaves options without a swatch as they were, stacked or not', async () => {
    const plain = [
      { value: 'measured', label: 'Measured' },
      { value: 'estimated', label: 'Estimated' },
    ] as const;
    expect(await layoutAt(2, 257, plain)).toEqual(['row', 'row']);
  });
});
