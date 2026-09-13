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

export interface BodyTextProps {
  readonly children: ReactNode;
  readonly tone?: 'normal' | 'error' | 'muted';
}

/**
 * Body copy, left-aligned with a 1.5 line height.
 *
 * Left, not centred. Centred ragged-both-edges text measurably slows
 * reading for low-vision and dyslexic readers, and the penalty compounds at
 * large font scale where one sentence wraps to five lines — which is
 * exactly the setting this population is most likely to be using. Every
 * body paragraph in the app was centred.
 *
 * `allowFontScaling` is deliberately left at its default of true, and no
 * `maxFontSizeMultiplier` is set: the text must scale with the OS setting
 * without limit, which is what `Screen`'s scroll container makes safe.
 */
export function BodyText({ children, tone = 'normal' }: BodyTextProps) {
  return <Text style={[styles.base, TONE_STYLE[tone]]}>{children}</Text>;
}

const TONE_STYLE = StyleSheet.create({
  normal: { color: tokens.color.text },
  error: { color: tokens.color.error, fontWeight: '600' },
  muted: { color: tokens.color.textMuted },
});

const styles = StyleSheet.create({
  base: {
    fontSize: tokens.typography.baseFontSizePx,
    lineHeight: tokens.typography.baseFontSizePx * tokens.typography.lineHeight,
    textAlign: 'left',
  },
});
