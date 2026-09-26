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
import { enqueueVolumetricObservationCreate } from '../src/db/offlineWrites';
import {
  amountError,
  checkEntry,
  methodError,
  STOMA_OUTPUT_LOINC_CODE,
  toCanonicalValueString,
  type EntryCheck,
} from '../src/entry/useStomaOutputEntry';
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

/**
 * The Add Output screen (P2.S2b, SRS §3.1).
 *
 * ## The save confirms from the local write
 *
 * `docs/sync-contract.md` §9.5 and SRS §4.5: the local write IS the
 * confirmation, and no network response is ever waited on.
 * `enqueueVolumetricObservationCreate` commits the observation row and its
 * queue entry in one transaction, and this screen shows its confirmation the
 * moment that resolves. It then *asks* the sync worker to run, and does not
 * care whether it succeeds — a patient in a hospital lift must see the same
 * confirmation, at the same speed, as one on Wi-Fi.
 *
 * ## The toggle starts unanswered
 *
 * `method` is `undefined` until the patient picks, never defaulted to
 * Measured. `Observation.method` is the *only* stored representation of that
 * choice, so a default is indistinguishable afterwards from a deliberate
 * answer and would quietly make AC 2.2 AC2's history badges wrong.
 *
 * ## Why an unfetched threshold blocks the save
 *
 * Thresholds are admin-managed configuration and this app must not invent
 * them (CLAUDE.md). Until `validation_thresholds_cache` has been filled by a
 * sync cycle there is nothing to validate against, and saving anyway would
 * mean writing an entry that skipped Tier 1 client-side. Signing in requires
 * a network round-trip, so in practice this state is brief and only occurs
 * before the first cycle completes.
 */
export default function AddOutput(): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation(['common', 'mobile', 'validationErrors', 'validationWarnings']);
  const database = useDatabaseState();
  const { requestSync } = useSyncStatus();

  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<MeasuredOrEstimated | undefined>(undefined);
  const [effectiveDateTime, setEffectiveDateTime] = useState(() => clockNow());
  const [check, setCheck] = useState<EntryCheck | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const measurementSystem = DEFAULT_MEASUREMENT_SYSTEM;
  const units = unitsForMeasurementSystem(measurementSystem);

  const cached = useCachedThresholds(database);

  const save = useCallback(
    async (confirmedWarning: boolean) => {
      if (database.status !== 'ready' || cached == null) return;

      const outcome = checkEntry({
        draft: { amountText, method, effectiveDateTime },
        measurementSystem,
        thresholds: cached.thresholds,
        // No local profile table yet, so no surgery date to bound against —
        // the Tier 1 rule exists and is exercised server-side, and lands here
        // at P4.S1 when onboarding captures the date.
        surgeryDate: null,
        now: clockNow(),
      });
      setCheck(outcome);

      if (outcome.kind === 'blocked' || outcome.kind === 'estimated-unavailable') return;
      // A Tier 2 warning asks once and then saves. It can never block
      // (SRS §3.8, AC 13.2 AC1) — a real 2,500 mL day is the data point the
      // care team most needs.
      if (outcome.kind === 'needs-confirmation' && !confirmedWarning) return;

      const canonical = toCanonicalValueString(amountText, measurementSystem);
      if (canonical === undefined || method === undefined) return;

      setSaving(true);
      setSaveFailed(false);
      try {
        await enqueueVolumetricObservationCreate(
          database.executor,
          {
            code: STOMA_OUTPUT_LOINC_CODE,
            valueQuantityValue: canonical,
            valueQuantityUnit: 'mL',
            effectiveDatetime: toWireInstant(effectiveDateTime),
            measuredOrEstimated: method,
            enteredMeasurementSystem: measurementSystem,
          },
          clockNow,
        );
      } catch {
        // The local write is the save. If it failed there is nothing to
        // confirm, and telling the patient it worked would be the one lie
        // this screen must never tell.
        setSaving(false);
        setSaveFailed(true);
        return;
      }

      // Committed. Ask the worker to run, but never wait on it: §9.5.
      requestSync();
      router.replace('/home?saved=1');
    },
    [amountText, method, effectiveDateTime, database, cached, measurementSystem, requestSync],
  );

  if (phase !== 'authenticated') return <Redirect href="/login" />;

  const blocked = check?.kind === 'blocked' ? check.errors : [];
  const amountRuleCode = amountError(blocked)?.ruleCode;
  const methodRuleCode = methodError(blocked)?.ruleCode;

  return (
    <Screen>
      <Heading>{t('common:entry.stomaOutputHeading')}</Heading>

      {cached === null ? (
        <BodyText tone="error">{t('mobile:entry.thresholdsUnavailableBody')}</BodyText>
      ) : null}

      <NumericField
        label={t('common:entry.stomaOutputAmountLabel')}
        hint={t('common:entry.stomaOutputAmountHint')}
        value={amountText}
        onChangeText={setAmountText}
        unitLabel={units.volumeUnit}
        errorMessage={
          amountRuleCode === undefined ? undefined : t(`validationErrors:${amountRuleCode}`)
        }
      />

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
        <BodyText tone="error" live="assertive">
          {t('common:entry.estimatedUnavailableBody')}
        </BodyText>
      ) : null}

      <View>
        <BodyText>{t('common:entry.whenLabel')}</BodyText>
        <BodyText tone="muted">{t('common:entry.whenHint')}</BodyText>
        <BodyText>
          {formatDateTime(effectiveDateTime, undefined, { timeZone: deviceTimeZone() })}
        </BodyText>
        <Button
          label={t('common:entry.whenUseNowButton')}
          variant="secondary"
          onPress={() => {
            setEffectiveDateTime(clockNow());
          }}
        />
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
        <Button
          label={t('common:entry.saveButton')}
          busy={saving}
          disabled={cached === null}
          onPress={() => {
            void save(false);
          }}
        />
      )}

      {saveFailed ? (
        <BodyText tone="error" live="assertive">
          {t('common:entry.saveFailedBody')}
        </BodyText>
      ) : null}
    </Screen>
  );
}
