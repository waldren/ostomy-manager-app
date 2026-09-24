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
import { PixelRatio, Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * The selected-option glyph.
 *
 * A module constant rather than a literal in the JSX, and not a catalog key
 * either: it is a decorative mark, not copy. There is nothing here to
 * translate — every locale renders the same character — and putting a
 * symbol in the i18n catalog would invite someone to "translate" it.
 *
 * It is rendered in its own `accessible={false}` element beside the label,
 * so a screen reader never announces "check Measured": the selection
 * reaches assistive technology through `accessibilityState.checked`, which
 * is the correct channel, and this glyph is purely for sighted users who
 * cannot rely on the colour (WCAG 1.4.1).
 */
const SELECTED_MARK = '✓';

export interface Choice<TValue extends string> {
  readonly value: TValue;
  readonly label: string;
  readonly hint?: string | undefined;
  /**
   * An optional colour swatch rendered beside the label — today, a step of
   * the urine colour scale (SRS §3.7, AC 12.1 AC3).
   *
   * **Decorative, always.** It is hidden from assistive technology and the
   * `label` carries the whole meaning, so a patient who cannot distinguish
   * the colours reads exactly the same scale. That is the rule SRS §5.4
   * states and this prop is shaped to make hard to break: there is no way
   * to supply a swatch INSTEAD of a label, because `label` is required.
   */
  readonly swatchColor?: string | undefined;
}

export interface ChoiceGroupProps<TValue extends string> {
  readonly label: string;
  readonly choices: readonly Choice<TValue>[];
  /**
   * `undefined` means **nothing chosen yet**, and for the Measured/Estimated
   * toggle that is the only correct initial state. Defaulting to either
   * option would satisfy Tier 1's `METHOD_REQUIRED` without the patient
   * having answered — and since `method` is the only stored representation
   * of that choice, a wrong default is indistinguishable afterwards from a
   * deliberate answer (SRS §3.1's mandatory toggle; AC 2.2 AC2).
   */
  readonly value: TValue | undefined;
  readonly onChange: (next: TValue) => void;
  /**
   * A line under the group's label, for something the label cannot carry
   * without becoming a paragraph — "colour on its own is a useful entry",
   * say. Visible text, and referenced by `aria-describedby` so a screen
   * reader reaches it from the group rather than only when tabbing past it.
   *
   * Distinct from a `Choice`'s own `hint`, which describes ONE option.
   */
  readonly hint?: string | undefined;
  readonly errorMessage?: string | undefined;
}

/**
 * A single-choice group — a radio group, rendered as buttons.
 *
 * `accessibilityRole="radio"` with `accessibilityState.checked` on each
 * option, inside a container with `role="radiogroup"`, so a screen reader
 * announces "2 of 2, selected" rather than reading two unrelated buttons. A
 * row of `Pressable`s with a highlight is the shape this would otherwise
 * take, and it conveys the selection by colour alone.
 *
 * The selected option therefore carries three independent signals: the
 * accessible checked state, a heavier border, and a check mark in the visible
 * label. Colour is the fourth and is never load-bearing (WCAG 1.4.1).
 */
export function ChoiceGroup<TValue extends string>({
  label,
  choices,
  value,
  onChange,
  hint,
  errorMessage,
}: ChoiceGroupProps<TValue>) {
  const labelId = useId();
  const hintId = useId();
  const errorId = useId();
  const invalid = errorMessage !== undefined;

  return (
    <View style={styles.container}>
      <Text nativeID={labelId} style={styles.label}>
        {label}
      </Text>
      {hint === undefined ? null : (
        <Text nativeID={hintId} style={styles.hint}>
          {hint}
        </Text>
      )}

      <View
        role="radiogroup"
        accessibilityLabel={label}
        aria-labelledby={labelId}
        aria-describedby={hint === undefined ? undefined : hintId}
        accessibilityHint={hint}
        aria-invalid={invalid}
        aria-errormessage={invalid ? errorId : undefined}
        style={styles.options}
      >
        {choices.map((choice) => {
          const selected = choice.value === value;
          return (
            <Pressable
              key={choice.value}
              onPress={() => {
                onChange(choice.value);
              }}
              accessibilityRole="radio"
              accessibilityLabel={choice.label}
              accessibilityHint={choice.hint}
              accessibilityState={{ checked: selected, selected }}
              style={[styles.option, selected ? styles.optionSelected : undefined]}
            >
              {selected ? (
                <Text style={styles.mark} accessible={false}>
                  {SELECTED_MARK}
                </Text>
              ) : null}
              {choice.swatchColor === undefined ? null : (
                // `accessible={false}` and no label: a screen reader
                // announces the text only, which is what keeps colour from
                // being a second, unequal carrier of the same meaning.
                // Bordered so a very pale swatch is still visible against
                // the surface — a 1.4.11 concern for the shape, not the
                // colour it contains.
                <View
                  accessible={false}
                  importantForAccessibility="no"
                  style={[styles.swatch, { backgroundColor: choice.swatchColor }]}
                />
              )}
              <Text style={[styles.optionLabel, selected ? styles.optionLabelSelected : undefined]}>
                {choice.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {invalid ? (
        <Text nativeID={errorId} style={styles.error} accessibilityLiveRegion="polite" role="alert">
          {errorMessage}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Computed once at module load, like every other token-derived measure here.
 * `PixelRatio.getFontScale()` is the user's OS text-size setting; the `max`
 * keeps it from shrinking below the base when that setting is below 1.
 */
const SWATCH_SIZE = Math.max(tokens.spacing.xl, tokens.spacing.xl * PixelRatio.getFontScale());

const styles = StyleSheet.create({
  container: { gap: tokens.spacing.xs },
  label: {
    fontSize: tokens.typography.baseFontSizePx,
    fontWeight: '600',
    color: tokens.color.text,
  },
  // Full body size, not a smaller "caption" — this population skews older
  // and post-surgical (CLAUDE.md), and a hint nobody can read is not a hint.
  // Matches `NumericField`'s.
  hint: {
    fontSize: tokens.typography.baseFontSizePx,
    lineHeight: tokens.typography.baseFontSizePx * tokens.typography.lineHeight,
    color: tokens.color.textMuted,
  },
  // Wraps rather than forcing two options onto one line: at a large OS text
  // size two side-by-side labels truncate, and a truncated "Estimated"
  // is a clinical distinction the patient can no longer read.
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing.sm },
  swatch: {
    // Scales with the OS text size, and starts from `xl` rather than `md`.
    //
    // At a fixed 12dp the four palest steps of the urine scale are
    // indistinguishable to anyone — adjacent-pair contrast runs 1.09:1 to
    // 1.47:1 — and this population's age-related lens yellowing degrades
    // exactly the blue/yellow axis the scale lives on. Meanwhile at Android's
    // largest font scale the label reached ~32px beside a 12px square.
    //
    // The swatch is the MATCHING affordance: the patient looks at what they
    // passed and matches it. No success criterion sets a minimum size for a
    // decorative graphic, but SRS §5.4's scalable-text and this-population
    // clauses both bear on it.
    width: SWATCH_SIZE,
    height: SWATCH_SIZE,
    borderRadius: tokens.radius.sm,
    borderWidth: 1,
    borderColor: tokens.color.border,
  },
  option: {
    flexDirection: 'row',
    gap: tokens.spacing.xs,
    flexGrow: 1,
    flexBasis: 140,
    minHeight: tokens.touchTarget.minSize,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.md,
    borderWidth: 2,
    borderColor: tokens.color.textMuted,
    borderRadius: tokens.radius.md,
  },
  optionSelected: {
    // No new "selected" colour token. The selection is already carried by
    // the accessible checked state, a doubled border and a check mark in the
    // label; a bespoke background would add a fourth signal whose contrast
    // nobody has computed. `surface` is an existing token with published
    // ratios against `text` (15.90:1).
    borderWidth: 4,
    borderColor: tokens.color.primary,
    backgroundColor: tokens.color.surface,
  },
  optionLabel: {
    fontSize: tokens.typography.baseFontSizePx,
    color: tokens.color.text,
    textAlign: 'center',
  },
  optionLabelSelected: { fontWeight: '700' },
  mark: {
    fontSize: tokens.typography.baseFontSizePx,
    fontWeight: '700',
    color: tokens.color.primary,
  },
  error: {
    fontSize: tokens.typography.baseFontSizePx,
    lineHeight: tokens.typography.baseFontSizePx * tokens.typography.lineHeight,
    color: tokens.color.error,
    fontWeight: '600',
  },
});
