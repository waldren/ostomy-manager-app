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
import { useId } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChangeText: (next: string) => void;
  readonly hint?: string | undefined;
  readonly errorMessage?: string | undefined;
  /** Grows to several lines, for free text like a meal description. */
  readonly multiline?: boolean;
  /**
   * A hard cap on what the patient can type, matching the column bound.
   *
   * Present so the field cannot produce a value the server will refuse —
   * refusing an over-long description is correct server-side, but letting
   * someone write 2,500 characters and only then telling them is not.
   */
  readonly maxLength?: number;
}

/**
 * Free-text entry, the prose counterpart to `NumericField`.
 *
 * Shares that component's accessibility contract rather than re-deriving it:
 * the label is associated by `accessibilityLabelledBy` AND repeated in
 * `accessibilityLabel`, because the association is respected on Android but
 * not reliably by VoiceOver on a bare `TextInput`, and an unlabelled text box
 * is unusable with a screen reader. The error is announced through a live
 * region rather than only turning the border red (WCAG 1.4.1).
 *
 * `allowFontScaling` stays at its default of true with no
 * `maxFontSizeMultiplier`: the text must scale with the OS setting without
 * limit, which `Screen`'s scroll container is what makes safe.
 *
 * `textAlignVertical: 'top'` on the multiline variant is not cosmetic — the
 * Android default centres the caret vertically in a tall box, so a patient
 * starts typing in the middle of an apparently empty field.
 */
export function TextField({
  label,
  value,
  onChangeText,
  hint,
  errorMessage,
  multiline = false,
  maxLength,
}: TextFieldProps) {
  const labelId = useId();
  const errorId = useId();
  const invalid = errorMessage !== undefined;

  return (
    <View style={styles.container}>
      <Text nativeID={labelId} style={styles.label}>
        {label}
      </Text>
      {hint === undefined ? null : <Text style={styles.hint}>{hint}</Text>}

      <TextInput
        style={[
          styles.input,
          multiline ? styles.multiline : undefined,
          invalid ? styles.invalid : undefined,
        ]}
        value={value}
        onChangeText={onChangeText}
        accessibilityLabel={label}
        accessibilityLabelledBy={labelId}
        accessibilityHint={hint}
        aria-invalid={invalid}
        aria-errormessage={invalid ? errorId : undefined}
        multiline={multiline}
        textAlignVertical={multiline ? 'top' : 'center'}
        {...(maxLength === undefined ? {} : { maxLength })}
        allowFontScaling
      />

      {invalid ? (
        <Text nativeID={errorId} style={styles.error} accessibilityLiveRegion="polite" role="alert">
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: tokens.spacing.xs },
  label: {
    fontSize: tokens.typography.baseFontSizePx,
    fontWeight: '600',
    color: tokens.color.text,
  },
  hint: {
    fontSize: tokens.typography.baseFontSizePx,
    lineHeight: tokens.typography.baseFontSizePx * tokens.typography.lineHeight,
    color: tokens.color.textMuted,
  },
  input: {
    borderWidth: 2,
    borderColor: tokens.color.text,
    borderRadius: tokens.radius.md,
    paddingHorizontal: tokens.spacing.md,
    paddingVertical: tokens.spacing.md,
    minHeight: tokens.touchTarget.minSize,
    fontSize: tokens.typography.baseFontSizePx,
    color: tokens.color.text,
  },
  // Three lines at the base size, and it grows from there with the OS text
  // setting rather than clipping.
  multiline: { minHeight: tokens.touchTarget.minSize * 2 },
  // A thicker border, not merely a red one: the invalid state must survive
  // greyscale and colour-blindness (WCAG 1.4.1).
  invalid: { borderColor: tokens.color.error, borderWidth: 3 },
  error: {
    fontSize: tokens.typography.baseFontSizePx,
    lineHeight: tokens.typography.baseFontSizePx * tokens.typography.lineHeight,
    color: tokens.color.error,
    fontWeight: '600',
  },
});
