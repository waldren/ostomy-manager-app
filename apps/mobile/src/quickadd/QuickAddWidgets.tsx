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
import { convertVolumeForDisplay, unitsForMeasurementSystem } from '@ostomy/core/units';
import type { MeasurementSystem } from '@ostomy/core/units';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { View } from 'react-native';

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
        const label = describe(suggestion, measurementSystem, t);
        // A suggestion this release cannot NAME is not offered. A value-set
        // member an admin added after the release shipped has no catalog copy
        // (CLAUDE.md: "renders as 'Another option' — a reachable state, not a
        // defensive one"), and for a colour-only entry the colour is the whole
        // entry, so "Another option · no amount" would be a one-tap button
        // whose meaning the patient cannot read. The entry screens remain, and
        // they resolve the same code against the live cache.
        if (label === undefined) return null;
        return (
          <View key={suggestion.key}>
            <Button
              label={label}
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
              suggestion inspectable at all — there is no review screen for
              these until P4.S3.
            */}
            <BodyText tone="muted">
              {t('common:quickAdd.repeatCount', { count: suggestion.occurrences })}
            </BodyText>
            <Button
              label={t('common:quickAdd.editButton')}
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
function describe(
  suggestion: QuickAddSuggestion,
  measurementSystem: MeasurementSystem,
  // i18next's own type, not a structural `(key, options) => string`: under
  // `exactOptionalPropertyTypes` the narrower signature does not accept
  // `TFunction`, and widening it here would be writing a second, looser
  // contract for the catalog than the one the rest of the app compiles against.
  t: TFunction<readonly ['common', 'mobile']>,
): string | undefined {
  if (suggestion.kind === 'volumeless-urine') {
    const colorKey = labelKeyFor(URINE_COLOR_LABEL_NAMESPACE, suggestion.urineColorCode);
    if (colorKey === undefined) return undefined;
    return t('common:quickAdd.colorOnlyLabel', { color: t(colorKey) });
  }

  const amount = formatVolumeQuantity(
    convertVolumeForDisplay(
      Number(suggestion.canonicalValue),
      unitsForMeasurementSystem(suggestion.enteredMeasurementSystem),
      unitsForMeasurementSystem(measurementSystem),
    ),
  );
  const method = t(`common:method.${suggestion.method}`);

  const fluidTypeKey =
    suggestion.fluidTypeCode === null
      ? undefined
      : labelKeyFor('fluidType', suggestion.fluidTypeCode);
  if (fluidTypeKey !== undefined) {
    return t('common:quickAdd.volumeWithTypeLabel', {
      amount,
      fluidType: t(fluidTypeKey),
      method,
    });
  }

  return t('common:quickAdd.volumeLabel', { amount, method });
}
