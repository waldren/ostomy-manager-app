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
 * Tests for the screen container.
 *
 * `src/ui/` shipped with no specs, and the activity capture in this
 * component is why that mattered: the handler was placed on `ScrollView`,
 * which builds its native props as `{ ...otherProps, ...own handlers }` and
 * therefore OVERRIDES a caller-supplied `onStartShouldSetResponderCapture`
 * (verified in react-native 0.86.3's ScrollView source). The prop was
 * silently discarded, so taps never extended the session and the doc
 * comment described behaviour that did not happen.
 */

import { fireEvent, render } from '@testing-library/react-native';
import { Text } from 'react-native';

import { Screen } from './Screen';

const mockMarkActivity = jest.fn();

jest.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ markActivity: mockMarkActivity }),
}));

jest.mock('react-native-safe-area-context', () => {
  const { View } = jest.requireActual('react-native');
  return { SafeAreaView: View, SafeAreaProvider: View };
});

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Screen', () => {
  it('renders its children', async () => {
    const view = await render(
      <Screen>
        <Text>a day of entries</Text>
      </Screen>,
    );

    expect(view.getByText('a day of entries')).toBeTruthy();
  });

  it('marks the session active when the patient touches the screen', async () => {
    /**
     * The whole point of the primitive. `FOREGROUND_IDLE_LOCK_MS` measures
     * from the last recorded activity, and nothing recorded any: the
     * "idle" lock was a hard cap running from unlock, so a patient part-way
     * through filling in an entry is locked out mid-form.
     */
    const view = await render(
      <Screen>
        <Text testID="content">a day of entries</Text>
      </Screen>,
    );

    fireEvent(view.getByTestId('content'), 'touchStart', {
      nativeEvent: { touches: [], changedTouches: [] },
    });

    expect(mockMarkActivity).toHaveBeenCalled();
  });

  it('does not hang the touch handler on the ScrollView, which discards it', async () => {
    /**
     * The assertion above is necessary but not sufficient, which a mutation
     * check showed: moving `onTouchStart` onto the ScrollView keeps it
     * passing, because RNTL resolves handlers from the React element rather
     * than from the native props ScrollView actually assembles.
     *
     * On a device it would be dropped — ScrollView spreads `...otherProps`
     * and then assigns its own `onTouchStart`, exactly as it does for
     * `onStartShouldSetResponderCapture`. So this pins the placement
     * directly.
     */
    const view = await render(
      <Screen>
        <Text testID="content">a day of entries</Text>
      </Screen>,
    );

    expect(view.getByTestId('scroll').props.onTouchStart).toBeUndefined();
  });

  it('marks the session active on a scroll drag', async () => {
    const view = await render(
      <Screen>
        <Text testID="content">a day of entries</Text>
      </Screen>,
    );

    fireEvent(view.getByTestId('scroll'), 'scrollBeginDrag', {
      nativeEvent: { contentOffset: { x: 0, y: 0 } },
    });

    expect(mockMarkActivity).toHaveBeenCalled();
  });

  it('scrolls, so content stays reachable at large text sizes (WCAG 1.4.4)', async () => {
    // Every screen was a centred flex container with no scroll view, which
    // clips overflow at BOTH ends — at large Dynamic Type the heading runs
    // off the top and the button off the bottom with no gesture that
    // reaches either. This population is the one most likely to have large
    // text turned on.
    const view = await render(
      <Screen>
        <Text>a day of entries</Text>
      </Screen>,
    );

    const scroll = view.getByTestId('scroll');
    expect(scroll).toBeTruthy();
    expect(scroll.props.contentContainerStyle).toEqual(
      expect.arrayContaining([expect.objectContaining({ flexGrow: 1 })]),
    );
  });
});
