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
import { Pressable, StyleSheet, Text, View } from 'react-native';

export interface TagOption {
  readonly value: string;
  readonly label: string;
}

export interface TagGroupProps {
  readonly label: string;
  readonly options: readonly TagOption[];
  readonly selected: readonly string[];
  readonly onToggle: (value: string) => void;
  readonly hint?: string | undefined;
}

/** The selected-tag glyph. A decorative mark, not copy — see `ChoiceGroup`'s constant for the full argument. */
const SELECTED_MARK = '✓';

/**
 * A **multi**-select group, the counterpart to `ChoiceGroup`'s single-select.
 *
 * The distinction is not cosmetic and it is the reason this is a separate
 * component rather than a `multiple` prop: the accessible roles differ.
 * `ChoiceGroup` renders `radio` inside a `radiogroup` — "one of these" —
 * while each option here is a `checkbox` with its own checked state, which is
 * what tells a screen-reader user that tapping a second tag does not clear
 * the first. Conflating them behind a flag is how one of the two ends up
 * announcing the wrong thing.
 *
 * As in `ChoiceGroup`, selection carries three independent signals — the
 * accessible checked state, a heavier border, and a check mark — so it
 * survives greyscale and colour-blindness (WCAG 1.4.1). Colour is never
 * load-bearing.
 *
 * There is no "required" state and no error slot, deliberately: every use of
 * this component so far is an optional annotation (AC 2.4 AC1's meal tags),
 * and adding the affordance would invite making one mandatory without
 * thinking about whether "none of these" is a meaningful answer.
 */
export function TagGroup({ label, options, selected, onToggle, hint }: TagGroupProps) {
  const labelId = useId();

  return (
    <View style={styles.container}>
      <Text nativeID={labelId} style={styles.label}>
        {label}
      </Text>
      {hint === undefined ? null : <Text style={styles.hint}>{hint}</Text>}

      <View accessibilityLabel={label} aria-labelledby={labelId} style={styles.options}>
        {options.map((option) => {
          const isSelected = selected.includes(option.value);
          return (
            <Pressable
              key={option.value}
              onPress={() => {
                onToggle(option.value);
              }}
              accessibilityRole="checkbox"
              accessibilityLabel={option.label}
              accessibilityState={{ checked: isSelected }}
              style={[styles.option, isSelected ? styles.optionSelected : undefined]}
            >
              {isSelected ? (
                <Text style={styles.mark} accessible={false}>
                  {SELECTED_MARK}
                </Text>
              ) : null}
              <Text
                style={[styles.optionLabel, isSelected ? styles.optionLabelSelected : undefined]}
              >
                {option.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
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
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: tokens.spacing.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: tokens.spacing.xs,
    // A full 44pt target even though a tag is a small word: this population
    // skews older and post-surgical, and the requirement is not relaxed for
    // controls that happen to be optional.
    minHeight: tokens.touchTarget.minSize,
    paddingVertical: tokens.spacing.md,
    paddingHorizontal: tokens.spacing.md,
    borderWidth: 2,
    borderColor: tokens.color.textMuted,
    borderRadius: tokens.radius.md,
  },
  optionSelected: {
    borderWidth: 4,
    borderColor: tokens.color.primary,
    backgroundColor: tokens.color.surface,
  },
  optionLabel: { fontSize: tokens.typography.baseFontSizePx, color: tokens.color.text },
  optionLabelSelected: { fontWeight: '700' },
  mark: {
    fontSize: tokens.typography.baseFontSizePx,
    fontWeight: '700',
    color: tokens.color.primary,
  },
});
