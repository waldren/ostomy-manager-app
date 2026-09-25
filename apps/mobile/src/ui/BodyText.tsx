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
  /**
   * `warning` exists so a Tier 2 soft warning stops wearing the destructive
   * voice.
   *
   * The entry screens rendered `entry.warningHeading` — "Does this look
   * right?" — in `error`, i.e. bold `color.error`. The copy is right: it asks
   * rather than scolds, and the confirm button is an ordinary action. The
   * PRESENTATION put an overridable data-quality prompt in the red that
   * CLAUDE.md and SRS §5.4 reserve for the red-flag heart-rate prompt. That
   * prompt does not exist yet, so there would have been nothing louder left to
   * escalate to when it ships — which is the precise mechanism by which a real
   * red flag becomes ignorable.
   *
   * Keep `error` for actual failures (a save that did not happen, a store that
   * would not open).
   */
  readonly tone?: 'normal' | 'error' | 'warning' | 'muted';
  /**
   * Announce this text when it appears, for content that only exists after the
   * user acted — a validation outcome, a save failure, a confirmation prompt.
   *
   * Without it a screen-reader user presses Save, the screen changes, and they
   * hear nothing with focus still on the button. `NumericField` and
   * `ChoiceGroup` already do this for their own error text; standalone
   * paragraphs had no way to.
   *
   * `assertive` interrupts; reserve it for something that blocked the action.
   */
  readonly live?: 'polite' | 'assertive';
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
export function BodyText({ children, tone = 'normal', live }: BodyTextProps) {
  return (
    <Text
      style={[styles.base, TONE_STYLE[tone]]}
      accessibilityLiveRegion={live}
      // `alert` only when the message interrupts. A polite region is ordinary
      // content that happens to be new.
      role={live === 'assertive' ? 'alert' : undefined}
    >
      {children}
    </Text>
  );
}

const TONE_STYLE = StyleSheet.create({
  normal: { color: tokens.color.text },
  error: { color: tokens.color.error, fontWeight: '600' },
  // 7.41:1 on white, computed rather than claimed (`packages/ui`'s tokens).
  warning: { color: tokens.color.warning, fontWeight: '600' },
  muted: { color: tokens.color.textMuted },
});

const styles = StyleSheet.create({
  base: {
    fontSize: tokens.typography.baseFontSizePx,
    lineHeight: tokens.typography.baseFontSizePx * tokens.typography.lineHeight,
    textAlign: 'left',
  },
});
