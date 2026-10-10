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

import { formatDateTime, formatVolumeUnitLabel } from '@ostomy/core/i18n';
import type { MeasuredOrEstimated } from '@ostomy/core/validation';
import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import type { LocalProfile } from '../src/db/repositories/profileRepository';
import { withProfile } from '../src/onboarding/withProfile';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import { useCachedThresholds } from '../src/entry/useCachedThresholds';
import { enqueueVolumetricObservationCreate } from '../src/db/offlineWrites';
import { parseDraftParams } from '../src/quickadd/draftParams';
import {
  amountError,
  checkEntry,
  methodError,
  STOMA_OUTPUT_LOINC_CODE,
  toCanonicalValueString,
  type EntryCheck,
} from '../src/entry/useStomaOutputEntry';
import { unitsForMeasurementSystem } from '../src/lib/units/measurementSystem';
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
function AddOutputScreen({ profile }: { readonly profile: LocalProfile }): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation(['common', 'mobile', 'validationErrors', 'validationWarnings']);
  const database = useDatabaseState();
  const { requestSync } = useSyncStatus();

  /**
   * Pre-filled from a Quick-Add widget's "Change before saving" (P3.S4,
   * Epic 3), when opened that way.
   *
   * `useState`'s initialiser, so it is the screen's starting state and then
   * ordinary state — a patient who clears the field is not re-filled on the
   * next render, which an effect synchronising params into state would do.
   *
   * Every param is validated by `parseDraftParams`: a value it does not
   * recognise is dropped, so this screen behaves exactly as it does when
   * opened from the dashboard button rather than half-filling from a stale or
   * hand-typed link. And nothing here is trusted on save — a prefill is as
   * untrusted as typing, and the same two tiers run either way.
   */
  const draft = parseDraftParams(useLocalSearchParams());
  const [amountText, setAmountText] = useState(draft.amount ?? '');
  const [method, setMethod] = useState<MeasuredOrEstimated | undefined>(draft.method);
  const [effectiveDateTime, setEffectiveDateTime] = useState(() => clockNow());
  const [check, setCheck] = useState<EntryCheck | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // Destructured so the callbacks below depend on these VALUES rather than on
  // `profile`, whose identity the gate controls.
  const { measurementSystem, surgeryDate } = profile;
  const units = unitsForMeasurementSystem(measurementSystem);

  const cached = useCachedThresholds(database);

  const save = useCallback(
    async (confirmedWarning: boolean) => {
      if (database.status !== 'ready' || cached == null) return;

      const outcome = checkEntry({
        draft: { amountText, method, effectiveDateTime },
        measurementSystem,
        thresholds: cached.thresholds,
        // The patient's own surgery date (P4.S1), as a calendar date, with the
        // zone this entry is being made in — the rule compares THEIR day.
        surgeryDate,
        enteredTimezone: deviceTimeZone(),
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
    [
      amountText,
      method,
      effectiveDateTime,
      database,
      cached,
      measurementSystem,
      surgeryDate,
      requestSync,
    ],
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
        unitLabel={formatVolumeUnitLabel(units.volumeUnit, undefined, 'short')}
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

/**
 * The profile arrives as a prop, never read inside — see `withProfile`. Two
 * fields come off it, and a fallback for either would be worse than not
 * rendering: `measurementSystem` is what every amount is rendered AND recorded
 * as (ADR-0012, permanent per row), and `surgeryDate` is the Tier 1 lower bound
 * that silently stops applying when it is absent.
 */
export default withProfile(AddOutputScreen);
