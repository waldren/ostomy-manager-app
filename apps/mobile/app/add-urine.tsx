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

import { formatDateTime } from '@ostomy/core/i18n';
import type { MeasuredOrEstimated } from '@ostomy/core/validation';
import { Redirect, router } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import { useCachedThresholds } from '../src/entry/useCachedThresholds';
import {
  enqueueVolumelessUrineCreate,
  enqueueVolumetricObservationCreate,
} from '../src/db/offlineWrites';
import { VALUE_SET_KEY } from '../src/db/repositories/valueSetsRepository';
import { UrineColorChoice } from '../src/entry/UrineColorChoice';
import { amountError, methodError, toCanonicalValueString } from '../src/entry/useStomaOutputEntry';
import {
  checkUrineEntry,
  hasSomethingToRecord,
  type EntryCheck,
} from '../src/entry/useVoidedUrineEntry';
import { useValueSetOptions } from '../src/entry/useValueSetOptions';
import {
  DEFAULT_MEASUREMENT_SYSTEM,
  unitsForMeasurementSystem,
} from '../src/lib/units/measurementSystem';
import { deviceTimeZone, now as clockNow, toWireInstant } from '../src/lib/utils/clock';
import { useSyncStatus } from '../src/sync/SyncProvider';
import { BodyText } from '../src/ui/BodyText';
import { Button } from '../src/ui/Button';
import { ChoiceGroup } from '../src/ui/ChoiceGroup';
import { Heading } from '../src/ui/Heading';
import { NumericField } from '../src/ui/NumericField';
import { Screen } from '../src/ui/Screen';

/** LOINC 9187-6 — voided urine. The third code the API accepts (P3.S2). */
const VOIDED_URINE_LOINC_CODE = '9187-6';

/**
 * The Add Urine screen (SRS §3.7, AC 12.1).
 *
 * The other two volumetric screens ask for an amount and a
 * Measured/Estimated answer, both required. This one is the exception the
 * spec carves out, and the exception is the point of the feature.
 *
 * ## Both inputs are optional; one of them is required
 *
 * **AC 12.1 AC1**: with an amount, the Measured/Estimated toggle is
 * mandatory, exactly as on stoma output and intake.
 *
 * **AC 12.1 AC2**: with no amount, a colour alone is a savable entry. A
 * patient who cannot measure still produces a hydration signal, and that
 * population is the one whose hydration matters most — so the amount field
 * says "optional" in its own label rather than letting someone discover it
 * by abandoning the entry.
 *
 * **AC 12.1 AC3**: the colour scale carries a text label per step and
 * announces distinguishably. That lives in `UrineColorChoice`, with the
 * reasoning.
 *
 * ## The toggle appears and disappears with the amount
 *
 * Typing an amount reveals it; clearing the amount hides it AND clears the
 * selection. Not merely hidden: `method` is the only stored representation
 * of that choice, and a hidden-but-retained "Estimated" would be saved on an
 * entry with no number for it to describe —
 * `validateVolumelessObservation` rejects that (`METHOD_NOT_APPLICABLE`) and
 * so does the local `observations_method_needs_a_value` CHECK. Clearing the
 * state is what keeps the screen from building an entry its own validator
 * refuses.
 *
 * ## Which write path, and why two
 *
 * `enqueueVolumetricObservationCreate` when there is an amount,
 * `enqueueVolumelessUrineCreate` when there is not. Two functions rather
 * than one with optional fields, for the reason given on
 * `validateVolumelessObservation`: the rule set — and here the column set —
 * follows from which one the caller picks, so a stoma output entry cannot
 * omit its volume by forgetting a field.
 *
 * ## The save still confirms from the local write
 *
 * §9.5, unchanged from the other two screens: the local transaction is the
 * confirmation and no network response is ever waited on.
 */
export default function AddUrine(): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation(['common', 'mobile', 'validationErrors', 'validationWarnings']);
  const database = useDatabaseState();
  const { requestSync } = useSyncStatus();

  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<MeasuredOrEstimated | undefined>(undefined);
  const [urineColorCode, setUrineColorCode] = useState<string | undefined>(undefined);
  const [effectiveDateTime] = useState(() => clockNow());
  const [check, setCheck] = useState<EntryCheck | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const measurementSystem = DEFAULT_MEASUREMENT_SYSTEM;
  const units = unitsForMeasurementSystem(measurementSystem);
  const colors = useValueSetOptions(VALUE_SET_KEY.URINE_COLOR);

  const cached = useCachedThresholds(database);

  const changeAmount = useCallback((next: string) => {
    setAmountText(next);
    // Clearing the amount clears the toggle with it — see the module
    // comment: a retained selection would be saved on an entry with no
    // number, which this app's own validator rejects.
    if (next.trim() === '') setMethod(undefined);
  }, []);

  const save = useCallback(
    async (confirmedWarning: boolean) => {
      if (database.status !== 'ready' || cached == null) return;

      const outcome = checkUrineEntry({
        draft: { amountText, method, urineColorCode, effectiveDateTime },
        measurementSystem,
        thresholds: cached.thresholds,
        surgeryDate: null,
        now: clockNow(),
      });
      setCheck(outcome);

      if (outcome.kind === 'blocked' || outcome.kind === 'estimated-unavailable') return;
      if (outcome.kind === 'needs-confirmation' && !confirmedWarning) return;

      setSaving(true);
      setSaveFailed(false);
      try {
        if (amountText.trim() === '') {
          // Guarded by the render below, which offers no Save button in this
          // state — but asserted here too, because this is the branch that
          // decides whether a row with no clinical value at all is written.
          if (urineColorCode === undefined) {
            setSaving(false);
            return;
          }
          await enqueueVolumelessUrineCreate(
            database.executor,
            {
              code: VOIDED_URINE_LOINC_CODE,
              effectiveDatetime: toWireInstant(effectiveDateTime),
              enteredMeasurementSystem: measurementSystem,
              urineColorCode,
            },
            clockNow,
          );
        } else {
          const canonical = toCanonicalValueString(amountText, measurementSystem);
          if (canonical === undefined || method === undefined) {
            setSaving(false);
            return;
          }
          await enqueueVolumetricObservationCreate(
            database.executor,
            {
              code: VOIDED_URINE_LOINC_CODE,
              valueQuantityValue: canonical,
              valueQuantityUnit: 'mL',
              effectiveDatetime: toWireInstant(effectiveDateTime),
              measuredOrEstimated: method,
              enteredMeasurementSystem: measurementSystem,
              // `null` rather than omitted when no colour was picked, the
              // same convention `fluidTypeCode` follows on the intake
              // screen: an unanswered optional question is an answer of
              // "none", not an absent key.
              urineColorCode: urineColorCode ?? null,
            },
            clockNow,
          );
        }
      } catch {
        setSaving(false);
        setSaveFailed(true);
        return;
      }

      requestSync();
      router.replace('/home?saved=1');
    },
    [
      amountText,
      method,
      urineColorCode,
      effectiveDateTime,
      database,
      cached,
      measurementSystem,
      requestSync,
    ],
  );

  if (phase !== 'authenticated') return <Redirect href="/login" />;

  const recordingAnAmount = amountText.trim() !== '';
  const somethingToRecord = hasSomethingToRecord({
    amountText,
    method,
    urineColorCode,
    effectiveDateTime,
  });
  const blocked = check?.kind === 'blocked' ? check.errors : [];
  const amountRuleCode = amountError(blocked)?.ruleCode;
  const methodRuleCode = methodError(blocked)?.ruleCode;
  // A blocked error whose field surface is not on screen. See the catch-all in
  // the render for why this is not defensive padding.
  const unsurfacedBlocked = blocked.find(
    (error) =>
      (error.ruleCode === methodRuleCode && !recordingAnAmount) ||
      (error.ruleCode !== methodRuleCode && error.ruleCode !== amountRuleCode),
  );

  return (
    <Screen>
      <Heading>{t('common:entry.urineHeading')}</Heading>

      {cached === null ? (
        <BodyText tone="error">{t('mobile:entry.thresholdsUnavailableBody')}</BodyText>
      ) : null}

      {/* AC 12.1 AC2 — optional, and the label says so before the save. */}
      <NumericField
        label={t('common:entry.urineAmountLabel')}
        hint={t('common:entry.urineAmountHint')}
        value={amountText}
        onChangeText={changeAmount}
        unitLabel={units.volumeUnit}
        errorMessage={
          amountRuleCode === undefined ? undefined : t(`validationErrors:${amountRuleCode}`)
        }
      />

      {/* AC 12.1 AC1 — mandatory with an amount, absent without one. */}
      {recordingAnAmount ? (
        <ChoiceGroup<MeasuredOrEstimated>
          label={t('common:entry.methodLabel')}
          value={method}
          onChange={setMethod}
          choices={[
            {
              value: 'measured',
              label: t('common:method.measured'),
              hint: t('common:entry.methodMeasuredHint'),
            },
            {
              value: 'estimated',
              label: t('common:method.estimated'),
              hint: t('common:entry.methodEstimatedHint'),
            },
          ]}
          errorMessage={
            methodRuleCode === undefined ? undefined : t(`validationErrors:${methodRuleCode}`)
          }
        />
      ) : null}

      {check?.kind === 'estimated-unavailable' ? (
        <BodyText tone="error" live="assertive">
          {t('common:entry.estimatedUnavailableBody')}
        </BodyText>
      ) : null}

      {/* AC 12.1 AC3 — the colour scale. */}
      <UrineColorChoice options={colors} value={urineColorCode} onChange={setUrineColorCode} />

      <View>
        <BodyText>{t('common:entry.whenLabel')}</BodyText>
        <BodyText>
          {formatDateTime(effectiveDateTime, undefined, { timeZone: deviceTimeZone() })}
        </BodyText>
      </View>

      {check?.kind === 'needs-confirmation' ? (
        <View>
          <BodyText tone="warning" live="polite">
            {t('common:entry.warningHeading')}
          </BodyText>
          {check.warnings.map((warning) => (
            <BodyText key={warning.ruleCode}>
              {t(`validationWarnings:${warning.ruleCode}`)}
            </BodyText>
          ))}
          <Button
            label={t('common:entry.warningConfirmButton')}
            busy={saving}
            onPress={() => {
              void save(true);
            }}
          />
          <Button
            label={t('common:entry.warningEditButton')}
            variant="secondary"
            onPress={() => {
              setCheck(undefined);
            }}
          />
        </View>
      ) : (
        <>
          {/*
            Save is always PRESENT, and disabled until the entry records
            something.

            It used to be absent in that state. An absent control is
            undiscoverable: a screen-reader user builds their model of a form
            from what is in it, so a missing Save reads as "this form has no way
            to finish" rather than "I have one more thing to do". Its appearance
            and disappearance was also an unannounced change to the control set
            (WCAG 4.1.3) — typing an amount conjured a button silently, and
            clearing it removed the control that might hold focus.

            A disabled button needs a reason, which is the other half of what
            was wrong: the correction inbox already disabled Save for this same
            condition and rendered no explanation anywhere. The reason is both a
            hint on the control and a visible live-announced line, because a
            hint alone can be switched off in TalkBack.

            The condition itself is a UX affordance, not a rule — the server
            refuses an entry recording nothing, and `useVoidedUrineEntry`
            explains why duplicating that here as Tier 1 would be inventing a
            clinical rule in a screen.
          */}
          <Button
            label={t('common:entry.saveButton')}
            busy={saving}
            disabled={!somethingToRecord || cached === null}
            hint={somethingToRecord ? undefined : t('common:entry.urineNothingToSave')}
            onPress={() => {
              void save(false);
            }}
          />
          {!somethingToRecord ? (
            <BodyText tone="muted" live="polite">
              {t('common:entry.urineNothingToSave')}
            </BodyText>
          ) : null}
        </>
      )}

      {/*
        A Tier 1 rejection no field on this screen claimed.

        `METHOD_NOT_APPLICABLE` is the live case: it routes to `methodError`,
        and the only control rendering that is the Measured/Estimated group —
        which is mounted ONLY when an amount was entered, the exact inverse of
        the condition under which the rule fires. So a blocked save could
        change nothing on screen: no message, no announcement, focus unmoved.

        It looks unreachable today, because `changeAmount` clears `method`. But
        "unreachable" there is a property of two pieces of this screen agreeing
        with each other, and a Tier 1 rule's whole job is to fire when they stop
        agreeing.
      */}
      {unsurfacedBlocked !== undefined ? (
        <BodyText tone="error" live="assertive">
          {t(`validationErrors:${unsurfacedBlocked.ruleCode}`)}
        </BodyText>
      ) : null}

      {saveFailed ? (
        <BodyText tone="error" live="assertive">
          {t('common:entry.saveFailedBody')}
        </BodyText>
      ) : null}
    </Screen>
  );
}
