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

import { tokens } from '@ostomy/ui/tokens';
import type { ReactNode } from 'react';
import { StyleSheet, Text } from 'react-native';

export interface HeadingProps {
  readonly children: ReactNode;
  /** `1` is the screen's own heading. Use `2` for sections within it. */
  readonly level?: 1 | 2;
}

/**
 * A heading that is actually a heading to assistive technology.
 *
 * React Native has no heading levels, only `accessibilityRole="header"`, so
 * the rotor cannot distinguish them — which makes it all the more important
 * that every heading carries the role. Previously only the top title on
 * each screen did, so VoiceOver's heading rotor and TalkBack's heading
 * navigation found exactly one stop per screen, and on the login screen
 * that one stop was the product name rather than the actual heading.
 */
export function Heading({ children, level = 1 }: HeadingProps) {
  return (
    <Text accessibilityRole="header" style={level === 1 ? styles.h1 : styles.h2}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  h1: {
    fontSize: 28,
    fontWeight: '700',
    color: tokens.color.text,
    lineHeight: 28 * tokens.typography.lineHeight,
  },
  h2: {
    fontSize: 20,
    fontWeight: '700',
    color: tokens.color.text,
    lineHeight: 20 * tokens.typography.lineHeight,
  },
});
