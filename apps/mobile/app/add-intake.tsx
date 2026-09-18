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

import { formatDateTime, formatVolumeQuantity } from '@ostomy/core/i18n';
import type { MeasuredOrEstimated } from '@ostomy/core/validation';
import { Redirect, router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import { enqueueVolumetricObservationCreate } from '../src/db/offlineWrites';
import { readThresholds, type CachedThresholds } from '../src/db/repositories/thresholdsRepository';
import { VALUE_SET_KEY } from '../src/db/repositories/valueSetsRepository';
import {
  amountError,
  checkEntry,
  methodError,
  toCanonicalValueString,
  type EntryCheck,
} from '../src/entry/useStomaOutputEntry';
import { labelKeyFor, useValueSetOptions } from '../src/entry/useValueSetOptions';
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

/** LOINC 9000-1 — oral fluid intake. The second code the API accepts (P3.S1). */
const FLUID_INTAKE_LOINC_CODE = '9000-1';

/**
 * The Add Intake screen (SRS §3.1, AC 2.3).
 *
 * Structurally the Add Output screen with two additions, and it reuses that
 * screen's `checkEntry` rather than re-deriving validation: intake is a
 * volumetric entry under exactly the same Tier 1 and Tier 2 rules, including
 * the mandatory Measured/Estimated toggle (CLAUDE.md: the toggle applies to
 * every volumetric entry, not only to output).
 *
 * ## The two additions
 *
 * **Quick-select sizes (AC 2.3 AC2)** auto-fill the amount field. They come
 * from the `container_size` value set with their canonical mL, so an operator
 * can change what "a glass" means without an app release — which is what
 * "configurable" in the AC requires. They are labelled with the localized
 * amount rather than a catalog string, because a catalog key cannot carry a
 * number (ADR-0006) and "250 mL" localises properly where `glass_250` would
 * need one key per size forever.
 *
 * **The fluid category (AC 2.3 AC1)** is optional and says so in its label. A
 * categorised list beside a required amount reads as required unless it says
 * otherwise, and a patient who does not know what to pick must not be stopped.
 *
 * ## The save still confirms from the local write
 *
 * §9.5, unchanged from the output screen: the local transaction is the
 * confirmation and no network response is ever waited on.
 */
export default function AddIntake(): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation(['common', 'mobile', 'validationErrors', 'validationWarnings']);
  const database = useDatabaseState();
  const { requestSync } = useSyncStatus();

  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<MeasuredOrEstimated | undefined>(undefined);
  const [fluidTypeCode, setFluidTypeCode] = useState<string | undefined>(undefined);
  const [effectiveDateTime] = useState(() => clockNow());
  const [check, setCheck] = useState<EntryCheck | undefined>(undefined);
  const [cached, setCached] = useState<CachedThresholds | null | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const measurementSystem = DEFAULT_MEASUREMENT_SYSTEM;
  const units = unitsForMeasurementSystem(measurementSystem);
  const containers = useValueSetOptions(VALUE_SET_KEY.CONTAINER_SIZE);
  const fluidTypes = useValueSetOptions(VALUE_SET_KEY.FLUID_TYPE);

  useEffect(() => {
    if (database.status !== 'ready') return;
    let cancelled = false;
    readThresholds(database.executor)
      .then((value) => {
        if (!cancelled) setCached(value ?? null);
      })
      .catch(() => {
        if (!cancelled) setCached(null);
      });
    return () => {
      cancelled = true;
    };
  }, [database]);

  const save = useCallback(
    async (confirmedWarning: boolean) => {
      if (database.status !== 'ready' || cached == null) return;

      const outcome = checkEntry({
        draft: { amountText, method, effectiveDateTime },
        measurementSystem,
        thresholds: cached.thresholds,
        surgeryDate: null,
        now: clockNow(),
      });
      setCheck(outcome);

      if (outcome.kind === 'blocked' || outcome.kind === 'estimated-unavailable') return;
      if (outcome.kind === 'needs-confirmation' && !confirmedWarning) return;

      const canonical = toCanonicalValueString(amountText, measurementSystem);
      if (canonical === undefined || method === undefined) return;

      setSaving(true);
      setSaveFailed(false);
      try {
        await enqueueVolumetricObservationCreate(
          database.executor,
          {
            code: FLUID_INTAKE_LOINC_CODE,
            valueQuantityValue: canonical,
            valueQuantityUnit: 'mL',
            effectiveDatetime: toWireInstant(effectiveDateTime),
            measuredOrEstimated: method,
            enteredMeasurementSystem: measurementSystem,
            // `null` rather than omitted when the patient did not categorise.
            // The field is optional; an unanswered optional question is an
            // answer of "none", not an absent key.
            fluidTypeCode: fluidTypeCode ?? null,
          },
          clockNow,
        );
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
      fluidTypeCode,
      effectiveDateTime,
      database,
      cached,
      measurementSystem,
      requestSync,
    ],
  );

  if (phase !== 'authenticated') return <Redirect href="/login" />;

  const blocked = check?.kind === 'blocked' ? check.errors : [];
  const amountRuleCode = amountError(blocked)?.ruleCode;
  const methodRuleCode = methodError(blocked)?.ruleCode;

  return (
    <Screen>
      <Heading>{t('common:entry.intakeHeading')}</Heading>

      {cached === null ? (
        <BodyText tone="error">{t('mobile:common.startupErrorBody')}</BodyText>
      ) : null}

      <NumericField
        label={t('common:entry.intakeAmountLabel')}
        hint={t('common:entry.intakeAmountHint')}
        value={amountText}
        onChangeText={setAmountText}
        unitLabel={units.volumeUnit}
        errorMessage={
          amountRuleCode === undefined ? undefined : t(`validationErrors:${amountRuleCode}`)
        }
      />

      {/* AC 2.3 AC2 — at least three configurable quick-select sizes. */}
      {containers.status === 'ready' ? (
        <View>
          <BodyText>{t('common:entry.intakeQuickAddLabel')}</BodyText>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {containers.members
              .filter((member) => member.numericValue !== null)
              .map((member) => {
                // A `DisplayVolume`, not a bare number: the unit travels with
                // the value so `Intl` can render it, and the unit comes from
                // the member rather than being assumed — an admin could
                // legitimately configure a set in some other canonical unit.
                const amount = formatVolumeQuantity({
                  value: member.numericValue as number,
                  unit: units.volumeUnit,
                });
                return (
                  <Button
                    key={member.code}
                    label={amount}
                    variant="secondary"
                    onPress={() => {
                      // Auto-fills the field rather than saving: the AC says
                      // "auto-fill the volume field when tapped", and a
                      // one-tap save would skip the Measured/Estimated
                      // choice that Tier 1 requires.
                      setAmountText(String(member.numericValue));
                    }}
                  />
                );
              })}
          </View>
        </View>
      ) : null}

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

      {check?.kind === 'estimated-unavailable' ? (
        <BodyText tone="error">{t('common:entry.estimatedUnavailableBody')}</BodyText>
      ) : null}

      {/* AC 2.3 AC1 — the optional categorisation. */}
      {fluidTypes.status === 'ready' ? (
        <ChoiceGroup<string>
          label={t('common:entry.fluidTypeLabel')}
          value={fluidTypeCode}
          onChange={setFluidTypeCode}
          choices={fluidTypes.members.map((member) => {
            const key = labelKeyFor('fluidType', member.code);
            return {
              value: member.code,
              // A member with no catalog entry is real: an admin can add one
              // after this app ships. It renders as "Another option" rather
              // than as its raw code.
              label: key === undefined ? t('common:entry.unknownOptionLabel') : t(key),
            };
          })}
        />
      ) : fluidTypes.status === 'unavailable' ? (
        <BodyText tone="muted">{t('common:entry.optionsUnavailable')}</BodyText>
      ) : null}

      <View>
        <BodyText>{t('common:entry.whenLabel')}</BodyText>
        <BodyText>
          {formatDateTime(effectiveDateTime, undefined, { timeZone: deviceTimeZone() })}
        </BodyText>
      </View>

      {check?.kind === 'needs-confirmation' ? (
        <View>
          <BodyText tone="error">{t('common:entry.warningHeading')}</BodyText>
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
        <Button
          label={t('common:entry.saveButton')}
          busy={saving}
          disabled={cached === null}
          onPress={() => {
            void save(false);
          }}
        />
      )}

      {saveFailed ? <BodyText tone="error">{t('common:entry.saveFailedBody')}</BodyText> : null}
    </Screen>
  );
}
