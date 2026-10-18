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

import { formatVolumeQuantity } from '@ostomy/core/i18n';
import { tokens } from '@ostomy/ui/tokens';
import { convertVolumeForDisplay, unitsForMeasurementSystem } from '@ostomy/core/units';
import type { MeasurementSystem } from '@ostomy/core/units';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { StyleSheet, View } from 'react-native';

import {
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
} from '../entry/observationCodes';
import { URINE_COLOR_LABEL_NAMESPACE } from '../entry/UrineColorChoice';
import { labelKeyFor } from '../entry/useValueSetOptions';
import { BodyText } from '../ui/BodyText';
import { Button } from '../ui/Button';
import { Heading } from '../ui/Heading';

import type { QuickAddSuggestion } from './quickAddSuggestions';

/**
 * The dashboard's Quick-Add widgets (P3.S4, SRS §3.1, Epic 3).
 *
 * Two buttons per suggestion, matching Epic 3's two stories: the widget itself
 * logs the entry, and "Change before saving" opens the entry form pre-filled.
 * Both are plain `Button`s rather than a custom pressable card, so they inherit
 * the touch-target size, focus handling and contrast `packages/ui`'s primitives
 * already carry — a dashboard shortcut is not a reason to hand-roll a control
 * for a population the spec says skews older and post-surgical.
 *
 * ## Nothing here renders a busy state
 *
 * §5.1 again: no `busy` prop is passed, and there is nothing to pass one for.
 * A tap writes to local SQLite and navigates; the sync worker is asked to run
 * and never waited on (`docs/sync-contract.md` §9.5). A spinner on this button
 * would be describing a wait that does not happen.
 *
 * ## The amount is converted once, here
 *
 * A suggestion carries canonical mL (ADR-0004) and the system its source
 * entries were entered in. `convertVolumeForDisplay` renders it in the
 * patient's current system, which is also what makes ADR-0005's whole-unit
 * rounding for a cross-system conversion apply — and `formatVolumeQuantity`
 * supplies the unit wording from `Intl`, never a hand-written string (ADR-0006).
 */
export function QuickAddWidgets({
  suggestions,
  measurementSystem,
  onLog,
  onEdit,
}: {
  /** `undefined` while the first read settles. Renders nothing — see `useQuickAddSuggestions`. */
  readonly suggestions: readonly QuickAddSuggestion[] | undefined;
  readonly measurementSystem: MeasurementSystem;
  readonly onLog: (suggestion: QuickAddSuggestion) => void;
  readonly onEdit: (suggestion: QuickAddSuggestion) => void;
}): React.JSX.Element | null {
  const { t } = useTranslation(['common', 'mobile']);

  // One render for "not read yet" and for "nothing to suggest". Telling them
  // apart is what would put a loading state on this screen.
  if (suggestions === undefined || suggestions.length === 0) return null;

  return (
    <View>
      <Heading level={2}>{t('mobile:home.quickAddHeading')}</Heading>
      <BodyText tone="muted">{t('mobile:home.quickAddBody')}</BodyText>

      {suggestions.map((suggestion) => {
        const label = describeQuickAdd(suggestion, measurementSystem, t);
        const spokenLabel = describeQuickAdd(suggestion, measurementSystem, t, SPOKEN_UNITS);
        // A suggestion this release cannot NAME is not offered. A value-set
        // member an admin added after the release shipped has no catalog copy
        // (CLAUDE.md: "renders as 'Another option' — a reachable state, not a
        // defensive one"), and for a colour-only entry the colour is the whole
        // entry, so "Another option · no amount" would be a one-tap button
        // whose meaning the patient cannot read. The entry screens remain, and
        // they resolve the same code against the live cache.
        if (label === undefined) return null;
        return (
          // Each widget's buttons kept together, and apart from the next
          // widget's (P4.S3 slice 6 audit): at the largest OS text size the
          // "Change before saving" button sat flush against the NEXT widget's
          // log button, so which entry it changed was a guess.
          <View key={suggestion.key} style={styles.widget}>
            <Button
              label={label}
              // Units spelled out: "fl oz" is read letter by letter.
              accessibilityLabel={spokenLabel}
              // Spells out that tapping records an entry, and at what time.
              // The visible label is a value and a Measured/Estimated word; on
              // its own it does not say that a tap commits anything.
              hint={t('common:quickAdd.logHint')}
              onPress={() => {
                onLog(suggestion);
              }}
            />
            {/*
              The count is the patient's own history and is what justifies the
              shortcut existing. Shown rather than hidden behind the hint,
              because a number a patient can check is what makes a generated
              suggestion inspectable at all. Keeping and removing are on the
              Settings screen (P4.S3 slice 5b), not here.
            */}
            <BodyText tone="muted">{quickAddStatus(suggestion, t)}</BodyText>
            <Button
              label={t('common:quickAdd.editButton')}
              // Every widget has this button, so its spoken name says which
              // entry it changes (#150 review); the spacing above only told
              // sighted patients.
              accessibilityLabel={
                spokenLabel === undefined
                  ? undefined
                  : t('common:quickAdd.editButtonSpoken', { entry: spokenLabel })
              }
              variant="secondary"
              hint={t('common:quickAdd.editHint')}
              onPress={() => {
                onEdit(suggestion);
              }}
            />
          </View>
        );
      })}
    </View>
  );
}

/**
 * Which kind of entry a widget logs, named first in its label (#149 review): a
 * 350 mL stoma output and a 350 mL urine entry are otherwise two buttons with
 * one name. Keyed by the three Quick-Add codes; anything else is not offered.
 */
/** Amounts as a screen reader says them: "fl oz" is read letter by letter. */
const SPOKEN_UNITS = 'long';

const KIND_KEYS: Readonly<Record<string, string>> = {
  [STOMA_OUTPUT_LOINC_CODE]: 'common:quickAdd.kindOutput',
  [FLUID_INTAKE_LOINC_CODE]: 'common:quickAdd.kindIntake',
  [VOIDED_URINE_LOINC_CODE]: 'common:quickAdd.kindUrine',
};

/**
 * The widget's visible label.
 *
 * Always states the Measured/Estimated answer, and that is not decoration: a
 * tap re-asserts it with no form in between (ADR-0018 makes the toggle
 * mandatory on every volumetric entry), so a label that omitted it would ask
 * the patient to commit to an answer they cannot see.
 *
 * A fluid type is included when the entry had one, because a 250 mL coffee and
 * a 250 mL glass of water are different routines and the widget has to say
 * which it is. An unlabelled fluid-type code falls back to the amount and the
 * toggle alone, which is still a complete and true description of what a tap
 * would record — whereas an unlabelled COLOUR leaves nothing to say, because
 * the colour is the entire entry, so that case returns `undefined` and the
 * caller drops the widget. Neither renders the raw code, and neither
 * substitutes `fluidType.other`: an admin's new member is not "something
 * else".
 */
export function describeQuickAdd(
  suggestion: QuickAddSuggestion,
  measurementSystem: MeasurementSystem,
  // i18next's own type, not a structural `(key, options) => string`: under
  // `exactOptionalPropertyTypes` the narrower signature does not accept
  // `TFunction`, and widening it here would be writing a second, looser
  // contract for the catalog than the one the rest of the app compiles against.
  t: TFunction<readonly ['common', 'mobile']>,
  /** `'long'` for a screen reader: "fl oz" is read letter by letter. */
  unitDisplay: 'short' | 'long' = 'short',
): string | undefined {
  const kind = t(KIND_KEYS[suggestion.code] ?? 'common:quickAdd.kindOutput');
  if (suggestion.kind === 'volumeless-urine') {
    const colorKey = labelKeyFor(URINE_COLOR_LABEL_NAMESPACE, suggestion.urineColorCode);
    if (colorKey === undefined) return undefined;
    return t('common:quickAdd.colorOnlyLabel', { kind, color: t(colorKey) });
  }

  const amount = formatVolumeQuantity(
    convertVolumeForDisplay(
      Number(suggestion.canonicalValue),
      unitsForMeasurementSystem(suggestion.enteredMeasurementSystem),
      unitsForMeasurementSystem(measurementSystem),
    ),
    undefined,
    unitDisplay,
  );
  const method = t(`common:method.${suggestion.method}`);

  const fluidTypeKey =
    suggestion.fluidTypeCode === null
      ? undefined
      : labelKeyFor('fluidType', suggestion.fluidTypeCode);
  if (fluidTypeKey !== undefined) {
    return t('common:quickAdd.volumeWithTypeLabel', {
      kind,
      amount,
      fluidType: t(fluidTypeKey),
      method,
    });
  }

  return t('common:quickAdd.volumeLabel', { kind, amount, method });
}

/**
 * The line under a widget: how often the patient logged it, and whether they
 * chose to keep it (P4.S3 slice 5b). A kept widget whose routine has left the
 * window says only that it was kept — "You logged this 0 times recently" would
 * read as a fault.
 */
export function quickAddStatus(
  suggestion: QuickAddSuggestion,
  t: TFunction<readonly ['common', 'mobile']>,
): string {
  if (!suggestion.pinned) {
    return t('common:quickAdd.repeatCount', { count: suggestion.occurrences });
  }
  if (suggestion.occurrences === 0) return t('common:quickAdd.kept');
  return t('common:quickAdd.repeatCountKept', { count: suggestion.occurrences });
}

const styles = StyleSheet.create({
  widget: { gap: tokens.spacing.xs, marginBottom: tokens.spacing.lg },
});
