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

import { render } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';

import { ChoiceGroup } from './ChoiceGroup';

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

  /** The label gives way by wrapping, and the swatch and mark keep their size. */
  it('lets the label wrap within its option rather than running past the border', async () => {
    const screen = await render(
      <ChoiceGroup label="What colour?" choices={CHOICES} value="pale" onChange={() => {}} />,
    );

    const label = StyleSheet.flatten(screen.getByText('Pale yellow').props.style);
    const mark = StyleSheet.flatten(screen.getByText('✓').props.style);
    expect(label.flexShrink).toBe(1);
    expect(mark.flexShrink).toBe(0);
  });
});
