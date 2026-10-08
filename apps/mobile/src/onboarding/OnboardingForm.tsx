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
import type { SurgeryDateRuleCode } from '@ostomy/core/validation';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import type { LocalProfile, OstomyType } from '../db/repositories/profileRepository';
import { deviceTimeZone, now } from '../lib/utils/clock';
import { BodyText } from '../ui/BodyText';
import { Button } from '../ui/Button';
import { ChoiceGroup } from '../ui/ChoiceGroup';
import { Heading } from '../ui/Heading';
import { TextField } from '../ui/TextField';

import {
  MEASUREMENT_SYSTEM_LABEL_KEYS,
  MEASUREMENT_SYSTEM_OPTIONS,
  OSTOMY_TYPE_LABEL_KEYS,
  OSTOMY_TYPE_OPTIONS,
  SURGERY_DATE_RULE_COPY_KEYS,
} from './onboardingCopy';
import { provisionProfile, type ProfilePort } from './provisionProfile';
import {
  EMPTY_SURGERY_DATE_PARTS,
  SURGERY_DATE_FIELD_MAX_LENGTH,
  digitsOnly,
  readSurgeryDateParts,
  toSurgeryDateParts,
  type SurgeryDateParts,
} from './surgeryDateParts';

/** Nothing has been submitted yet, or the last attempt ended one of these ways. */
type SubmitState =
  | { readonly kind: 'editing' }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'refused'; readonly surgeryDateRule: SurgeryDateRuleCode }
  | { readonly kind: 'unreachable' }
  | { readonly kind: 'failed' };

export interface OnboardingFormProps {
  readonly port: ProfilePort;
  /** Called with the server's profile once provisioning succeeds. Records it and opens the gate. */
  readonly onProvisioned: (profile: LocalProfile) => Promise<void>;
  /**
   * The answers to open with, for a re-run after the server lost a profile this
   * device still holds. Absent for a first run, which is the normal case.
   */
  readonly prefill?: LocalProfile | undefined;
}

/**
 * The three questions (P4.S1 slice 2, SRS §3.0, Epic 7).
 *
 * ## Separate from the route, because of when state is seeded
 *
 * `app/onboarding.tsx` resolves the gate — signed in, profile known, server
 * reachable — and renders this only once it has an answer. That ordering is what
 * makes `prefill` work: `useState`'s initialiser runs on the first render, so a form
 * mounted while the gate was still checking would seed its fields from a profile
 * that had not arrived yet and then keep the blanks. Mounting the form after the
 * answer means the initialiser sees it, with no effect to re-seed and no "have I
 * seeded yet" flag to get wrong.
 *
 * ## Every answer is explicit, none is defaulted
 *
 * All three values start `undefined` on a first run, and each has its own reason: an
 * ostomy type decides which expected ranges the patient is measured against, the
 * surgery date becomes the Tier 1 lower bound on every entry they will ever make,
 * and the measurement system is ADR-0012's assertion about what the patient
 * themselves typed. A pre-selected `metric` would be indistinguishable afterwards
 * from a patient who chose it.
 *
 * ## It submits online, and says so when it cannot
 *
 * Provisioning is the one write in this app that is not queued — a sync push needs a
 * provisioned patient, so the bootstrap cannot be the thing that needs the
 * bootstrap. The patient signed in seconds ago, so a connection existed; when it has
 * since gone, the honest answer is a retry rather than a queued promise, and
 * `provisionProfile` makes that retry safe.
 */
export function OnboardingForm({
  port,
  onProvisioned,
  prefill,
}: OnboardingFormProps): React.JSX.Element {
  const { t } = useTranslation(['common', 'mobile']);

  const [ostomyType, setOstomyType] = useState<OstomyType | undefined>(prefill?.ostomyType);
  const [measurementSystem, setMeasurementSystem] = useState<MeasurementSystem | undefined>(
    prefill?.measurementSystem,
  );
  const [dateParts, setDateParts] = useState<SurgeryDateParts>(
    prefill === undefined ? EMPTY_SURGERY_DATE_PARTS : toSurgeryDateParts(prefill.surgeryDate),
  );
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'editing' });
  /** Messages appear only after a submit attempt, so nobody is scolded mid-typing. */
  const [attempted, setAttempted] = useState(false);

  /**
   * The patient's own local date, which is what makes the future check exact here
   * while the server has to allow the furthest-ahead timezone. Recomputed per render
   * rather than memoised: it costs one `DateTimeFormat`, and a cached value would go
   * stale for a patient who leaves this screen open past midnight — the one case
   * where being wrong refuses the date they have just lived through.
   */
  const today = toLocalDate(now(), deviceTimeZone());
  const dateEntry = readSurgeryDateParts(dateParts, today);

  const changePart = useCallback(
    (part: keyof SurgeryDateParts) => (next: string) => {
      setDateParts((current) => ({
        ...current,
        [part]: digitsOnly(next, SURGERY_DATE_FIELD_MAX_LENGTH[part]),
      }));
      // A refusal from the server is about the date that was sent, so editing the
      // date clears it rather than leaving a message that no longer applies.
      setSubmit((current) => (current.kind === 'refused' ? { kind: 'editing' } : current));
    },
    [],
  );

  /**
   * The message under the date fields, from whichever source is currently right: the
   * server's refusal if the last submit produced one, otherwise this device's own
   * check. Only after an attempt.
   */
  const surgeryDateError = useMemo(() => {
    if (submit.kind === 'refused') return t(SURGERY_DATE_RULE_COPY_KEYS[submit.surgeryDateRule]);
    if (!attempted) return undefined;
    if (dateEntry.status === 'incomplete') return t('common:onboarding.surgeryDateRequired');
    if (dateEntry.status === 'invalid') return t(SURGERY_DATE_RULE_COPY_KEYS[dateEntry.ruleCode]);
    return undefined;
  }, [attempted, dateEntry, submit, t]);

  const onSubmit = useCallback(() => {
    setAttempted(true);
    if (ostomyType === undefined || measurementSystem === undefined) return;
    if (dateEntry.status !== 'valid') return;

    setSubmit({ kind: 'submitting' });
    void (async () => {
      const outcome = await provisionProfile(port, {
        ostomyType,
        surgeryDate: dateEntry.wireDate,
        measurementSystem,
      });

      if (outcome.status === 'provisioned') {
        await onProvisioned(outcome.profile);
        return;
      }
      setSubmit(
        outcome.status === 'refused'
          ? { kind: 'refused', surgeryDateRule: outcome.surgeryDateRule }
          : { kind: outcome.status === 'unreachable' ? 'unreachable' : 'failed' },
      );
    })();
  }, [dateEntry, measurementSystem, onProvisioned, ostomyType, port]);

  const submitting = submit.kind === 'submitting';

  return (
    <>
      <Heading>{t('common:onboarding.heading')}</Heading>
      <BodyText>{t('common:onboarding.intro')}</BodyText>

      <ChoiceGroup<OstomyType>
        label={t('common:onboarding.ostomyTypeLabel')}
        hint={t('common:onboarding.ostomyTypeHint')}
        value={ostomyType}
        onChange={setOstomyType}
        choices={OSTOMY_TYPE_OPTIONS.map((option) => ({
          value: option,
          label: t(OSTOMY_TYPE_LABEL_KEYS[option]),
        }))}
        errorMessage={
          attempted && ostomyType === undefined
            ? t('common:onboarding.ostomyTypeRequired')
            : undefined
        }
      />

      {/*
        Three labelled fields rather than a picker. `surgeryDateParts.ts` carries the
        reasoning; the short version is that each field says which part it is, so
        there is no DD/MM ambiguity to get wrong, and no native module to rebuild.

        The error sits on the year because that is the field a wrong date is most
        often wrong in — a slipped century is the case the device cannot catch at all.
      */}
      <View>
        <Heading level={2}>{t('common:onboarding.surgeryDateLabel')}</Heading>
        <BodyText tone="muted">{t('common:onboarding.surgeryDateHint')}</BodyText>
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
        hint={t('common:onboarding.measurementSystemHint')}
        value={measurementSystem}
        onChange={setMeasurementSystem}
        choices={MEASUREMENT_SYSTEM_OPTIONS.map((option) => ({
          value: option,
          label: t(MEASUREMENT_SYSTEM_LABEL_KEYS[option]),
        }))}
        errorMessage={
          attempted && measurementSystem === undefined
            ? t('common:onboarding.measurementSystemRequired')
            : undefined
        }
      />

      {submit.kind === 'unreachable' ? (
        <View accessibilityLiveRegion="polite">
          <BodyText tone="error">{t('common:onboarding.unreachableBody')}</BodyText>
        </View>
      ) : null}

      {submit.kind === 'failed' ? (
        <View accessibilityLiveRegion="polite">
          <BodyText tone="error">{t('common:onboarding.failedBody')}</BodyText>
        </View>
      ) : null}

      <Button
        label={submitting ? t('common:onboarding.savingLabel') : t('common:onboarding.saveButton')}
        busy={submitting}
        disabled={submitting}
        onPress={onSubmit}
      />
    </>
  );
}
