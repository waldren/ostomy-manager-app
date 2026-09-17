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

export interface NumericFieldProps {
  readonly label: string;
  /** The raw text the patient typed. A string, never a number — see the component comment. */
  readonly value: string;
  readonly onChangeText: (next: string) => void;
  /** Unit shown beside the field. Rendered from the patient's measurement preference, never hardcoded. */
  readonly unitLabel: string;
  /** Tier 1 message when this field is blocking the save. Announced, not merely coloured. */
  readonly errorMessage?: string | undefined;
  readonly hint?: string | undefined;
}

/**
 * A labelled decimal entry field.
 *
 * ## The value is a string all the way to the database
 *
 * `TextInput` gives text; this component never parses it. A `Number()` here
 * would turn `"abc"` into `NaN` and `""` into `0`, destroying the difference
 * between "not filled in yet", "not a number" and "zero" — three inputs
 * whose Tier 1 outcomes differ (`VALUE_NOT_NUMERIC` vs.
 * `VALUE_NOT_POSITIVE`). `@ostomy/core/validation` takes `rawValueMl:
 * unknown` precisely so the raw text can be handed to it unparsed, and
 * ADR-0005 wants the entered precision preserved rather than round-tripped
 * through a float.
 *
 * ## Accessibility
 *
 * The label is associated by `accessibilityLabelledBy` AND repeated in the
 * input's own `accessibilityLabel`: the association is respected on Android
 * but not reliably by VoiceOver on a bare `TextInput`, and an unlabelled
 * number field is unusable with a screen reader. The error is wired through
 * `accessibilityState.invalid` plus live-region text, so it is announced
 * rather than only turning the border red (WCAG 1.4.1 — never colour alone).
 *
 * `keyboardType: 'decimal-pad'` rather than `'numeric'`: `'numeric'` on iOS
 * offers a keypad with no decimal separator at all, which makes a decimal
 * volume literally untypeable — and ADR-0005 requires decimals.
 */
export function NumericField({
  label,
  value,
  onChangeText,
  unitLabel,
  errorMessage,
  hint,
}: NumericFieldProps) {
  const labelId = useId();
  const errorId = useId();
  const invalid = errorMessage !== undefined;

  return (
    <View style={styles.container}>
      <Text nativeID={labelId} style={styles.label}>
        {label}
      </Text>
      {hint === undefined ? null : <Text style={styles.hint}>{hint}</Text>}

      <View style={[styles.inputRow, invalid ? styles.inputRowInvalid : undefined]}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          keyboardType="decimal-pad"
          inputMode="decimal"
          accessibilityLabel={label}
          accessibilityLabelledBy={labelId}
          accessibilityHint={hint}
          accessibilityState={invalid ? { disabled: false } : undefined}
          aria-invalid={invalid}
          aria-errormessage={invalid ? errorId : undefined}
          // The OS text-size setting must scale this without limit, same as
          // every other string in the app — `Screen`'s scroll container is
          // what makes that safe.
          allowFontScaling
        />
        <Text style={styles.unit} accessible={false}>
          {unitLabel}
        </Text>
      </View>

      {invalid ? (
        <Text
          nativeID={errorId}
          style={styles.error}
          // Announced when it appears, rather than found only by someone
          // who happens to swipe back to this field.
          accessibilityLiveRegion="polite"
          role="alert"
        >
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
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.sm,
    borderWidth: 2,
    borderColor: tokens.color.text,
    borderRadius: tokens.radius.md,
    paddingHorizontal: tokens.spacing.md,
    minHeight: tokens.touchTarget.minSize,
  },
  // A thicker border, not merely a red one: the invalid state must survive
  // greyscale and colour-blindness (WCAG 1.4.1). The message below carries
  // the actual meaning.
  inputRowInvalid: { borderColor: tokens.color.error, borderWidth: 3 },
  input: {
    flex: 1,
    fontSize: tokens.typography.baseFontSizePx,
    color: tokens.color.text,
    paddingVertical: tokens.spacing.md,
  },
  unit: { fontSize: tokens.typography.baseFontSizePx, color: tokens.color.textMuted },
  error: {
    fontSize: tokens.typography.baseFontSizePx,
    lineHeight: tokens.typography.baseFontSizePx * tokens.typography.lineHeight,
    color: tokens.color.error,
    fontWeight: '600',
  },
});
