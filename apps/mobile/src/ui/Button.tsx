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
import { ActivityIndicator, Pressable, StyleSheet, Text, type ViewStyle } from 'react-native';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive';

export interface ButtonProps {
  readonly label: string;
  readonly onPress: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  /** Shows a spinner and marks the control busy to assistive technology. */
  readonly busy?: boolean;
  /**
   * Extra context a label alone cannot carry — "this also removes your
   * diary from this phone". Read after the label by both screen readers.
   */
  readonly hint?: string;
}

/**
 * The app's only button.
 *
 * It exists because the login screen defined one locally and the home
 * screen re-implemented it inline with different colours, before a single
 * entry screen existed. Two copies is how one reviewed screen becomes five
 * unreviewed ones: every accessibility property — role, disabled and busy
 * state, minimum target size, hint association — gets re-derived per screen
 * and each derivation is a chance to omit one.
 *
 * Three things it guarantees that hand-rolled `Pressable`s did not:
 *
 * - **A 44pt minimum target**, from `tokens.touchTarget.minSize`. A hard
 *   requirement for this population, not polish.
 * - **`accessibilityState`** carrying disabled and busy, so a screen
 *   reader announces "dimmed" or "busy" rather than a control that appears
 *   to work and does nothing.
 * - **A non-colour signal for destructive actions.** Sign-out was a dark
 *   red button whose only difference from the green one was its colour —
 *   nothing in its accessible name said it destroys the local diary
 *   (WCAG 1.4.1). `hint` is how that reaches everyone, and the destructive
 *   variant also draws a heavier border so the distinction survives
 *   greyscale.
 */
export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  hint,
}: ButtonProps) {
  const inert = disabled || busy;

  return (
    <Pressable
      onPress={inert ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: inert, busy }}
      style={({ pressed }) => [
        styles.base,
        VARIANT_STYLE[variant],
        pressed && !inert ? styles.pressed : undefined,
        inert ? styles.inert : undefined,
      ]}
    >
      {busy ? <ActivityIndicator color={tokens.color.textOnPrimary} accessible={false} /> : null}
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const VARIANT_STYLE: Record<ButtonVariant, ViewStyle> = {
  primary: { backgroundColor: tokens.color.primary },
  secondary: { backgroundColor: tokens.color.primaryStrong },
  destructive: {
    backgroundColor: tokens.color.error,
    borderWidth: 3,
    borderColor: tokens.color.text,
  },
};

const styles = StyleSheet.create({
  base: {
    minHeight: tokens.touchTarget.minSize,
    paddingVertical: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.lg,
    borderRadius: tokens.radius.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing.sm,
  },
  // Opacity only on press, never as the disabled signal: a dimmed control
  // is invisible in the bright daylight and poor restroom lighting this app
  // is used in, and `accessibilityState` is what actually conveys it.
  pressed: { opacity: 0.85 },
  inert: { backgroundColor: tokens.color.textMuted },
  label: {
    color: tokens.color.textOnPrimary,
    fontSize: tokens.typography.baseFontSizePx,
    fontWeight: '600',
    textAlign: 'center',
  },
});
