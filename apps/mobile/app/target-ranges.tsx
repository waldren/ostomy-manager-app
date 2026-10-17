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

import {
  formatVolumeQuantity,
  formatVolumeUnitLabel,
  rangeBandKey,
  rangeBasisCopy,
  rangeTypeLabelKey,
} from '@ostomy/core/i18n';
import { convertVolumeForDisplay, unitsForMeasurementSystem } from '@ostomy/core/units';
import { Redirect, router } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import {
  cancelUnsentRangeCreate,
  enqueueRangeCreate,
  enqueueRangeStatusChange,
} from '../src/db/offlineWrites';
import type { LocalProfile } from '../src/db/repositories/profileRepository';
import { now as clockNow } from '../src/lib/utils/clock';
import { withProfile } from '../src/onboarding/withProfile';
import { readRangeForm, type RangeFormError } from '../src/ranges/rangeForm';
import type { RangeBounds, TargetRangeView } from '../src/ranges/targetRangeView';
import { useTargetRanges } from '../src/ranges/useTargetRanges';
import { useSyncStatus } from '../src/sync/SyncProvider';
import { BodyText } from '../src/ui/BodyText';
import { Button } from '../src/ui/Button';
import { Heading } from '../src/ui/Heading';
import { NumericField } from '../src/ui/NumericField';
import { Screen } from '../src/ui/Screen';

/** Ranges are stored in canonical mL (ADR-0004); no patient system is asserted on one. */
const CANONICAL_UNITS = unitsForMeasurementSystem('metric');

const FORM_ERROR_KEYS: Readonly<Record<RangeFormError['code'], string>> = {
  'needs-a-bound': 'common:targetRanges.errorNeedsBound',
  'not-a-number': 'common:targetRanges.errorNotNumber',
  'too-precise': 'common:targetRanges.errorTooPrecise',
  'outside-limits': 'common:targetRanges.errorOutsideLimits',
  'below-low': 'common:targetRanges.errorBelowLow',
};

const SOURCE_KEYS: Readonly<Record<TargetRangeView['source'], string>> = {
  physician: 'common:targetRanges.sourcePhysician',
  patient: 'common:targetRanges.sourcePatient',
  confirmed: 'common:targetRanges.sourceConfirmed',
  suggestion: 'common:targetRanges.notConfirmed',
};

/**
 * The patient's target ranges, and what they may do about them (P4.S3 slice 4,
 * SRS §3.9 and §3.10, AC 14.1).
 *
 * ## What a patient can do here, and nothing more
 *
 * The actions `docs/sync-contract.md` §7.6 allows a patient: use the typical
 * range, set their own, stop using their own, and accept or decline a range
 * waiting for them. Each is offline-first like an entry: the change and its
 * sync operation are saved together, the screen shows it at once, and the
 * server re-checks it on push. A physician's range is never edited from here
 * (AC 4); a patient may still save their own beside it, and the screen says
 * which one is in use.
 *
 * ## What it shows comes from the server, not from this phone
 *
 * Which value is in force is §3.9's precedence over the patient's rows and the
 * clinical defaults, and the server decides it (`GET /api/v1/ranges`, cached
 * every sync). The phone adds only its own unsent changes on top. So a phone
 * that has never connected shows nothing but a request to connect: there is no
 * default it could honestly show.
 *
 * ## Nothing here is used yet
 *
 * No entry is compared against these until P5.S2, and the intro says so.
 */
function TargetRangesScreen({ profile }: { readonly profile: LocalProfile }): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation(['common', 'mobile']);
  const database = useDatabaseState();
  const { isRunning, requestSync } = useSyncStatus();
  const executor = database.status === 'ready' ? database.executor : undefined;
  const { state, reload } = useTargetRanges(executor, isRunning);

  const units = unitsForMeasurementSystem(profile.measurementSystem);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [lowText, setLowText] = useState('');
  const [highText, setHighText] = useState('');
  const [formErrors, setFormErrors] = useState<readonly RangeFormError[]>([]);
  const [busy, setBusy] = useState(false);

  const valueText = useCallback(
    (bounds: RangeBounds): string => {
      // Converted for display through the one shared function, so ADR-0005's
      // rounding applies here exactly as it does on the web.
      const asText = (canonicalMl: number | null) =>
        canonicalMl === null
          ? null
          : formatVolumeQuantity(convertVolumeForDisplay(canonicalMl, CANONICAL_UNITS, units));
      const key = rangeBandKey({
        hasLow: bounds.lowValue !== null,
        hasHigh: bounds.highValue !== null,
      });
      return key === null
        ? t('common:targetRanges.empty')
        : t(key, { low: asText(bounds.lowValue), high: asText(bounds.highValue) });
    },
    [t, units],
  );

  /** Every action ends the same way: show the change, then try to send it. */
  const run = useCallback(
    async (write: () => Promise<unknown>) => {
      if (executor === undefined) return;
      setBusy(true);
      try {
        await write();
        setEditing(undefined);
        await reload();
        requestSync();
      } finally {
        setBusy(false);
      }
    },
    [executor, reload, requestSync],
  );

  const adoptTypical = useCallback(
    (view: TargetRangeView) => {
      const suggestion = view.suggestion;
      if (executor === undefined || suggestion === null) return;
      void run(() =>
        enqueueRangeCreate(
          executor,
          {
            rangeType: view.rangeType,
            lowValue: suggestion.lowValue === null ? null : String(suggestion.lowValue),
            highValue: suggestion.highValue === null ? null : String(suggestion.highValue),
            unit: view.unit,
            provenance: 'patient_confirmed_suggestion',
          },
          clockNow,
        ),
      );
    },
    [executor, run],
  );

  const saveOwn = useCallback(
    (view: TargetRangeView) => {
      if (executor === undefined) return;
      const result = readRangeForm({
        lowText,
        highText,
        measurementSystem: profile.measurementSystem,
        limits: view.limits,
      });
      if (result.status === 'invalid') {
        setFormErrors(result.errors);
        return;
      }
      setFormErrors([]);
      void run(() =>
        enqueueRangeCreate(
          executor,
          {
            rangeType: view.rangeType,
            lowValue: result.lowValue,
            highValue: result.highValue,
            unit: view.unit,
            provenance: 'patient_set',
          },
          clockNow,
        ),
      );
    },
    [executor, highText, lowText, profile.measurementSystem, run],
  );

  const stopOwn = useCallback(
    (view: TargetRangeView) => {
      const own = view.patientRange;
      if (executor === undefined || own === null) return;
      void run(async () => {
        // A value that has not left the phone is simply taken back.
        if (await cancelUnsentRangeCreate(executor, own.id)) return;
        await enqueueRangeStatusChange(executor, own, 'superseded', clockNow);
      });
    },
    [executor, run],
  );

  const decideProposal = useCallback(
    (view: TargetRangeView, status: 'active' | 'dismissed') => {
      const proposal = view.proposal;
      if (executor === undefined || proposal === null) return;
      void run(() => enqueueRangeStatusChange(executor, proposal, status, clockNow));
    },
    [executor, run],
  );

  if (phase !== 'authenticated') return <Redirect href="/login" />;

  const errorFor = (field: RangeFormError['field']) => {
    const error = formErrors.find((candidate) => candidate.field === field);
    return error === undefined ? undefined : t(FORM_ERROR_KEYS[error.code]);
  };

  return (
    <Screen>
      <Heading>{t('common:targetRanges.heading')}</Heading>
      <BodyText>{t('common:targetRanges.intro')}</BodyText>

      {state.status === 'loading' ? <BodyText>{t('mobile:common.loadingLabel')}</BodyText> : null}
      {state.status === 'never-fetched' ? (
        <BodyText>{t('common:targetRanges.needsConnection')}</BodyText>
      ) : null}
      {state.status === 'ready' && state.views.length === 0 ? (
        <BodyText>{t('common:targetRanges.empty')}</BodyText>
      ) : null}

      {state.status === 'ready'
        ? state.views.map((view) => {
            const isEditing = editing === view.rangeType;
            const own = view.patientRange;
            const sameAsTypical =
              own !== null &&
              view.suggestion !== null &&
              own.lowValue === view.suggestion.lowValue &&
              own.highValue === view.suggestion.highValue;
            const offerTypical =
              view.suggestion !== null && view.source !== 'physician' && !sameAsTypical;
            const basis = view.basis === null ? null : rangeBasisCopy(view.basis);

            return (
              <View key={view.rangeType} style={{ gap: 8 }}>
                <Heading level={2}>{t(rangeTypeLabelKey(view.rangeType))}</Heading>
                <BodyText>
                  {view.shown === null
                    ? t('common:targetRanges.needsConnection')
                    : valueText(view.shown)}
                </BodyText>
                <BodyText tone="muted">{t(SOURCE_KEYS[view.source])}</BodyText>

                {view.source !== 'suggestion' && view.suggestion !== null ? (
                  <BodyText tone="muted">
                    {t('common:targetRanges.typical', { value: valueText(view.suggestion) })}
                  </BodyText>
                ) : null}
                {basis === null ? null : (
                  <BodyText tone="muted">
                    {t(basis.key, { ostomyType: t(basis.ostomyTypeKey), months: basis.months })}
                  </BodyText>
                )}
                {view.divergesFromPhysician && own !== null ? (
                  <>
                    <BodyText>
                      {t('common:targetRanges.yourValue', { value: valueText(own) })}
                    </BodyText>
                    <BodyText>{t('common:targetRanges.divergesFromPhysician')}</BodyText>
                  </>
                ) : null}
                {view.waitingToSend ? (
                  // Announced when it appears, which is right after the patient's
                  // own action — the confirmation §9.5 says the local write is.
                  <BodyText tone="muted" live="polite">
                    {t('common:targetRanges.waitingToSend')}
                  </BodyText>
                ) : null}

                {view.proposal === null ? null : (
                  <>
                    <BodyText>
                      {t('common:targetRanges.proposal', { value: valueText(view.proposal) })}
                    </BodyText>
                    <Button
                      label={t('common:targetRanges.acceptProposalButton')}
                      disabled={busy}
                      onPress={() => {
                        decideProposal(view, 'active');
                      }}
                    />
                    <Button
                      label={t('common:targetRanges.dismissProposalButton')}
                      variant="secondary"
                      disabled={busy}
                      onPress={() => {
                        decideProposal(view, 'dismissed');
                      }}
                    />
                  </>
                )}

                {isEditing ? (
                  <View style={{ gap: 8 }}>
                    {view.source === 'physician' ? (
                      <BodyText>{t('common:targetRanges.physicianStaysNote')}</BodyText>
                    ) : null}
                    <BodyText tone="muted">{t('common:targetRanges.formHint')}</BodyText>
                    <NumericField
                      label={t('common:targetRanges.formLowLabel')}
                      value={lowText}
                      onChangeText={setLowText}
                      unitLabel={formatVolumeUnitLabel(units.volumeUnit, undefined, 'short')}
                      errorMessage={errorFor('low')}
                      allowsNegative={(view.limits?.minValue ?? 0) < 0}
                    />
                    <NumericField
                      label={t('common:targetRanges.formHighLabel')}
                      value={highText}
                      onChangeText={setHighText}
                      unitLabel={formatVolumeUnitLabel(units.volumeUnit, undefined, 'short')}
                      errorMessage={errorFor('high')}
                      allowsNegative={(view.limits?.minValue ?? 0) < 0}
                    />
                    <Button
                      label={t('common:targetRanges.formSaveButton')}
                      busy={busy}
                      disabled={busy}
                      onPress={() => {
                        saveOwn(view);
                      }}
                    />
                    <Button
                      label={t('common:targetRanges.formCancelButton')}
                      variant="secondary"
                      onPress={() => {
                        setEditing(undefined);
                        setFormErrors([]);
                      }}
                    />
                  </View>
                ) : (
                  <>
                    {offerTypical ? (
                      <Button
                        label={t('common:targetRanges.useTypicalButton')}
                        disabled={busy}
                        onPress={() => {
                          adoptTypical(view);
                        }}
                      />
                    ) : null}
                    <Button
                      label={
                        own === null
                          ? t('common:targetRanges.setOwnButton')
                          : t('common:targetRanges.changeOwnButton')
                      }
                      variant="secondary"
                      disabled={busy}
                      onPress={() => {
                        setEditing(view.rangeType);
                        setLowText('');
                        setHighText('');
                        setFormErrors([]);
                      }}
                    />
                    {own === null ? null : (
                      <Button
                        label={t('common:targetRanges.stopOwnButton')}
                        hint={t('common:targetRanges.stopOwnHint')}
                        variant="secondary"
                        disabled={busy}
                        onPress={() => {
                          stopOwn(view);
                        }}
                      />
                    )}
                  </>
                )}
              </View>
            );
          })
        : null}

      <Button
        label={t('mobile:navigation.backButton')}
        variant="secondary"
        onPress={() => {
          router.replace('/settings');
        }}
      />
    </Screen>
  );
}

export default withProfile(TargetRangesScreen);
