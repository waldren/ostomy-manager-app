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

import { toLocalDate, type MeasurementSystem } from '@ostomy/core/units';
import { Redirect, router } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import { enqueueProfileUpdate } from '../src/db/offlineWrites';
import type { LocalProfile, OstomyType } from '../src/db/repositories/profileRepository';
import { deviceTimeZone, now as clockNow } from '../src/lib/utils/clock';
import {
  MEASUREMENT_SYSTEM_LABEL_KEYS,
  MEASUREMENT_SYSTEM_OPTIONS,
  OSTOMY_TYPE_LABEL_KEYS,
  OSTOMY_TYPE_OPTIONS,
  SURGERY_DATE_RULE_COPY_KEYS,
} from '../src/onboarding/onboardingCopy';
import { useProfileState } from '../src/onboarding/ProfileProvider';
import {
  SURGERY_DATE_FIELD_MAX_LENGTH,
  digitsOnly,
  readSurgeryDateParts,
  toSurgeryDateParts,
  type SurgeryDateParts,
} from '../src/onboarding/surgeryDateParts';
import { withProfile } from '../src/onboarding/withProfile';
import { useSyncStatus } from '../src/sync/SyncProvider';
import { BodyText } from '../src/ui/BodyText';
import { Button } from '../src/ui/Button';
import { ChoiceGroup } from '../src/ui/ChoiceGroup';
import { Heading } from '../src/ui/Heading';
import { Screen } from '../src/ui/Screen';
import { TextField } from '../src/ui/TextField';

type SaveState = 'editing' | 'saving' | 'saved' | 'nothing-changed';

/**
 * Settings (P4.S3, SRS §3.10): "a persistent settings area, reachable at any
 * time". This build has one section, the profile, because §3.10's other areas
 * configure features that do not exist yet (#139) and a control that does
 * nothing is worse than no control.
 *
 * ## An edit is offline-first, like an entry
 *
 * Onboarding submits online because a sync push needs a provisioned patient.
 * An edit has no such problem, so it takes the ordinary path: the local row
 * and a sync `update` commit together (`enqueueProfileUpdate`), the screen
 * confirms from that, and the server re-validates when it is pushed
 * (`docs/sync-contract.md` §7.5). So the surgery date is checked here by the
 * same rules onboarding uses, and exactly — this device knows its own zone.
 *
 * ## Every screen changes with it
 *
 * The profile is held in memory by `ProfileProvider` and handed to screens as
 * a prop (`withProfile`), so saving re-reads it there. A new measurement system
 * then re-renders every amount in the app in the new units. Nothing stored is
 * rewritten (ADR-0004), and each entry keeps the system it was entered in
 * (ADR-0012), which is what the note under that question tells the patient.
 */
function SettingsScreen({ profile }: { readonly profile: LocalProfile }): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation(['common', 'mobile']);
  const database = useDatabaseState();
  const { requestSync } = useSyncStatus();
  const { refresh } = useProfileState();

  const [ostomyType, setOstomyType] = useState<OstomyType>(profile.ostomyType);
  const [measurementSystem, setMeasurementSystem] = useState<MeasurementSystem>(
    profile.measurementSystem,
  );
  const [dateParts, setDateParts] = useState<SurgeryDateParts>(
    toSurgeryDateParts(profile.surgeryDate),
  );
  const [save, setSave] = useState<SaveState>('editing');
  const [attempted, setAttempted] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // Per render, for `OnboardingForm`'s reason: a cached "today" goes stale for a
  // patient who leaves this open past midnight, and then refuses the date they
  // have just lived through.
  const today = toLocalDate(clockNow(), deviceTimeZone());
  const dateEntry = readSurgeryDateParts(dateParts, today);

  const edited = useCallback(() => {
    setSave((current) => (current === 'saving' ? current : 'editing'));
  }, []);

  const changePart = useCallback(
    (part: keyof SurgeryDateParts) => (next: string) => {
      setDateParts((current) => ({
        ...current,
        [part]: digitsOnly(next, SURGERY_DATE_FIELD_MAX_LENGTH[part]),
      }));
      edited();
    },
    [edited],
  );

  const surgeryDateError = useMemo(() => {
    if (!attempted) return undefined;
    if (dateEntry.status === 'incomplete') return t('common:onboarding.surgeryDateRequired');
    if (dateEntry.status === 'invalid') return t(SURGERY_DATE_RULE_COPY_KEYS[dateEntry.ruleCode]);
    return undefined;
  }, [attempted, dateEntry, t]);

  /** Absent only on a phone set up before this screen existed, until it has been online once. */
  const serverId = profile.serverId;

  const onSave = useCallback(() => {
    setAttempted(true);
    if (database.status !== 'ready' || serverId === undefined) return;
    if (dateEntry.status !== 'valid') return;

    const next = { ostomyType, surgeryDate: dateEntry.wireDate, measurementSystem };
    if (
      next.ostomyType === profile.ostomyType &&
      next.surgeryDate === profile.surgeryDate &&
      next.measurementSystem === profile.measurementSystem
    ) {
      // Not queued: an operation that changes nothing would still move the
      // profile's last-write-wins timestamp and could overwrite a real edit
      // made on another device a moment earlier.
      setSave('nothing-changed');
      return;
    }

    setSave('saving');
    void (async () => {
      await enqueueProfileUpdate(database.executor, serverId, next, clockNow);
      await refresh();
      requestSync();
      setSave('saved');
    })();
  }, [database, dateEntry, measurementSystem, ostomyType, profile, refresh, requestSync, serverId]);

  if (phase !== 'authenticated') return <Redirect href="/login" />;

  const saving = save === 'saving';

  return (
    <Screen>
      <Heading>{t('common:settings.heading')}</Heading>

      <Heading level={2}>{t('common:settings.profileHeading')}</Heading>
      <BodyText>{t('common:settings.profileIntro')}</BodyText>

      {serverId === undefined ? (
        <View accessibilityLiveRegion="polite">
          <BodyText tone="error">{t('common:settings.needsConnectionBody')}</BodyText>
          <Button
            label={t('common:settings.retryButton')}
            variant="secondary"
            busy={retrying}
            disabled={retrying}
            onPress={() => {
              setRetrying(true);
              void refresh().finally(() => {
                setRetrying(false);
              });
            }}
          />
        </View>
      ) : null}

      <ChoiceGroup<OstomyType>
        label={t('common:onboarding.ostomyTypeLabel')}
        hint={t('common:onboarding.ostomyTypeHint')}
        value={ostomyType}
        onChange={(next) => {
          setOstomyType(next);
          edited();
        }}
        choices={OSTOMY_TYPE_OPTIONS.map((option) => ({
          value: option,
          label: t(OSTOMY_TYPE_LABEL_KEYS[option]),
        }))}
      />

      <View>
        <Heading level={2}>{t('common:onboarding.surgeryDateLabel')}</Heading>
        <BodyText tone="muted">{t('common:onboarding.surgeryDateHint')}</BodyText>
        <BodyText tone="muted">{t('common:settings.surgeryDateChangeNote')}</BodyText>
        <TextField
          label={t('common:onboarding.surgeryDateDayLabel')}
          value={dateParts.day}
          onChangeText={changePart('day')}
          wholeNumber
          maxLength={SURGERY_DATE_FIELD_MAX_LENGTH.day}
        />
        <TextField
          label={t('common:onboarding.surgeryDateMonthLabel')}
          value={dateParts.month}
          onChangeText={changePart('month')}
          wholeNumber
          maxLength={SURGERY_DATE_FIELD_MAX_LENGTH.month}
        />
        <TextField
          label={t('common:onboarding.surgeryDateYearLabel')}
          hint={t('common:onboarding.surgeryDateYearHint')}
          value={dateParts.year}
          onChangeText={changePart('year')}
          wholeNumber
          maxLength={SURGERY_DATE_FIELD_MAX_LENGTH.year}
          errorMessage={surgeryDateError}
        />
      </View>

      <ChoiceGroup<MeasurementSystem>
        label={t('common:onboarding.measurementSystemLabel')}
        hint={t('common:settings.measurementSystemChangeNote')}
        value={measurementSystem}
        onChange={(next) => {
          setMeasurementSystem(next);
          edited();
        }}
        choices={MEASUREMENT_SYSTEM_OPTIONS.map((option) => ({
          value: option,
          label: t(MEASUREMENT_SYSTEM_LABEL_KEYS[option]),
        }))}
      />

      {save === 'saved' ? (
        <View accessibilityLiveRegion="polite">
          <BodyText>{t('common:settings.saved')}</BodyText>
        </View>
      ) : null}
      {save === 'nothing-changed' ? (
        <View accessibilityLiveRegion="polite">
          <BodyText tone="muted">{t('common:settings.nothingChanged')}</BodyText>
        </View>
      ) : null}

      <Button
        label={saving ? t('common:settings.savingLabel') : t('common:settings.saveButton')}
        busy={saving}
        disabled={saving || serverId === undefined}
        onPress={onSave}
      />

      {/* Its own screen rather than a section here: the profile form saves as
          one unit, and each range action saves on its own. Under its own
          heading, so a user moving by heading does not meet it as one more
          control of the surgery-date section. */}
      <Heading level={2}>{t('common:settings.targetRangesHeading')}</Heading>
      <BodyText>{t('common:settings.targetRangesIntro')}</BodyText>
      <Button
        label={t('common:settings.targetRangesButton')}
        variant="secondary"
        onPress={() => {
          router.push('/target-ranges');
        }}
      />

      <Button
        label={t('mobile:navigation.backButton')}
        variant="secondary"
        onPress={() => {
          router.replace('/home');
        }}
      />
    </Screen>
  );
}

/**
 * The profile arrives as a prop (`withProfile`), and seeds the form. Once
 * saved, `ProfileProvider` re-reads it and this prop changes; the form keeps
 * what the patient typed, which is the same thing.
 */
export default withProfile(SettingsScreen);
