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
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '../auth/AuthContext';

export interface ScreenProps {
  readonly children: ReactNode;
  /** Centres content vertically when it fits. Off for list-like screens. */
  readonly centred?: boolean;
}

/**
 * The container every screen in this app uses. Not optional.
 *
 * It exists because three separate accessibility defects were each a
 * missing wrapper, and fixing them per screen guarantees the next screen
 * reintroduces them.
 *
 * ## Scrolling (WCAG 1.4.4)
 *
 * Every screen was a `View` with `flex: 1` and `justifyContent: 'center'`,
 * and there was no `ScrollView` anywhere in the app. Text scales with the
 * OS font setting — correctly; nothing sets `allowFontScaling={false}` and
 * nothing should — but a non-scrolling centred flex container clips
 * overflow at BOTH ends. On a small phone at large Dynamic Type the title
 * runs off the top and the button off the bottom, with no gesture that can
 * reach either. `flexGrow: 1` on the content container is what preserves
 * centring while still allowing scroll when it does not fit.
 *
 * This population skews older and post-surgical. Large text is the setting
 * they are most likely to have on.
 *
 * ## Safe area
 *
 * `headerShown: false` with no safe-area handling only looked correct
 * because centred content never reached the edges. The moment anything
 * top-aligns, the title renders under the notch and the bottom control
 * under the home indicator.
 *
 * ## Keyboard
 *
 * Wrapped now rather than when the first `TextInput` lands. Without it, and
 * without the scroll view above, the numeric keypad covers the volume field
 * on any phone smaller than a Pro Max with no way to scroll it into view —
 * a guaranteed defect on the app's primary screen, not a risk.
 *
 * ## Activity
 *
 * Touches here mark the session active. The idle lock reads a timestamp
 * that nothing was updating, so a five-minute cap ran from unlock
 * regardless of use — and a patient part-way through an entry would be
 * locked out mid-form. Capturing at the container means no screen has to
 * remember, which is the point: the screens that take longest to fill in
 * are exactly the ones where an opt-in would be forgotten.
 */
export function Screen({ children, centred = true }: ScreenProps) {
  const { markActivity } = useAuth();

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.fill}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          testID="scroll"
          style={styles.fill}
          contentContainerStyle={[styles.content, centred && styles.centred]}
          keyboardShouldPersistTaps="handled"
          onScrollBeginDrag={markActivity}
        >
          {/*
            The touch handler lives HERE, on the inner View, not on the
            ScrollView.
            
            ScrollView assembles its native props as `{ ...otherProps, ...its
            own handlers }` and assigns `onStartShouldSetResponderCapture`
            AFTER the spread, so a caller-supplied one is silently
            overridden and never called (react-native 0.86.3,
            ScrollView.js). It forwards `onScrollBeginDrag`, which is why
            the drag signal worked and the tap signal did not — the doc
            comment above described behaviour that did not happen.

            `onTouchStart` rather than a responder-capture hook: it bubbles
            from any descendant, it is purely observational, and it cannot
            interfere with the responder negotiation that makes buttons and
            scrolling work. A capture hook would have to return `false` to
            avoid intercepting, which is a sharper edge for no gain.
          */}
          <View style={styles.inner} onTouchStart={markActivity}>
            {children}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: tokens.color.background },
  fill: { flex: 1 },
  content: { flexGrow: 1, padding: tokens.spacing.xl },
  centred: { justifyContent: 'center' },
  inner: { gap: tokens.spacing.lg },
});
