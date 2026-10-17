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
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo, View, type Text, type TextInput } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import { enqueueRangeCreate, enqueueRangeStatusChange } from '../src/db/offlineWrites';
import type { LocalProfile } from '../src/db/repositories/profileRepository';
import { now as clockNow } from '../src/lib/utils/clock';
import { withProfile } from '../src/onboarding/withProfile';
import {
  effectiveLimits,
  readRangeForm,
  toEditableText,
  type RangeFormError,
} from '../src/ranges/rangeForm';
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

const SOURCE_KEYS: Readonly<Record<TargetRangeView['source'], string>> = {
  physician: 'common:targetRanges.sourcePhysician',
  patient: 'common:targetRanges.sourcePatient',
  confirmed: 'common:targetRanges.sourceConfirmed',
  suggestion: 'common:targetRanges.notConfirmed',
};

type UnitDisplay = 'short' | 'long';

/** Amounts as a screen reader says them: "fl oz" is read letter by letter. */
const SPOKEN: UnitDisplay = 'long';

/** What the confirmation says takes over, because the screen knows. */
function stopConfirmKey(view: TargetRangeView): string {
  if (view.source === 'physician') return 'common:targetRanges.stopConfirmCareTeam';
  if (view.suggestion !== null) return 'common:targetRanges.stopConfirmTypical';
  return 'common:targetRanges.stopConfirmOther';
}

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
 * every sync). The phone adds only its own changes on top. So a phone that has
 * never connected shows nothing but a request to connect: there is no default
 * it could honestly show.
 *
 * ## For a screen-reader user (from the #147 review)
 *
 * - Every range has the same buttons, so each button's spoken name includes
 *   the measure, starting with the visible words (WCAG 2.5.3).
 * - Every action removes the control that had focus, so focus goes to the
 *   form's first field when it opens, to the first invalid field when a save
 *   is refused, and back to that range's heading after anything else.
 * - Every action is announced, saying what changed. A newly mounted live
 *   region is not read out reliably on Android, and "saved" said nothing.
 * - Amounts are spoken with the unit spelled out: "fl oz" is read as letters.
 *
 * None of these is verified on a device yet (#137 records the same for the
 * date pickers).
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
  const [confirmingStop, setConfirmingStop] = useState<string | undefined>(undefined);
  const [lowText, setLowText] = useState('');
  const [highText, setHighText] = useState('');
  const [formErrors, setFormErrors] = useState<readonly RangeFormError[]>([]);
  const [busy, setBusy] = useState(false);
  const [failedType, setFailedType] = useState<string | undefined>(undefined);

  const headingRefs = useRef(new Map<string, Text | null>());
  const lowInputRef = useRef<TextInput>(null);
  const highInputRef = useRef<TextInput>(null);
  const [focusTarget, setFocusTarget] = useState<
    { readonly kind: 'heading' | 'low' | 'high'; readonly rangeType: string } | undefined
  >(undefined);

  // After the render that put the target on screen, not before it.
  useEffect(() => {
    if (focusTarget === undefined) return;
    const node =
      focusTarget.kind === 'heading'
        ? headingRefs.current.get(focusTarget.rangeType)
        : focusTarget.kind === 'low'
          ? lowInputRef.current
          : highInputRef.current;
    if (node !== null && node !== undefined) {
      AccessibilityInfo.sendAccessibilityEvent(node, 'focus');
    }
    setFocusTarget(undefined);
  }, [focusTarget]);

  const measureOf = useCallback((rangeType: string) => t(rangeTypeLabelKey(rangeType)), [t]);

  const amountText = useCallback(
    (canonicalMl: number, unitDisplay: UnitDisplay = 'short') =>
      // Converted for display through the one shared function, so ADR-0005's
      // rounding applies here exactly as it does on the web.
      formatVolumeQuantity(
        convertVolumeForDisplay(canonicalMl, CANONICAL_UNITS, units),
        undefined,
        unitDisplay,
      ),
    [units],
  );

  const valueText = useCallback(
    (bounds: RangeBounds, unitDisplay: UnitDisplay = 'short'): string => {
      const asText = (canonicalMl: number | null) =>
        canonicalMl === null ? null : amountText(canonicalMl, unitDisplay);
      const key = rangeBandKey({
        hasLow: bounds.lowValue !== null,
        hasHigh: bounds.highValue !== null,
      });
      return key === null
        ? t('common:targetRanges.empty')
        : t(key, { low: asText(bounds.lowValue), high: asText(bounds.highValue) });
    },
    [amountText, t],
  );

  /**
   * Every action ends the same way: show the change, say what changed, put
   * focus back on that range, and try to send it. A failed write says so
   * rather than leaving the patient to wonder whether it happened.
   */
  const run = useCallback(
    async (rangeType: string, write: () => Promise<unknown>, announcement: string) => {
      if (executor === undefined) return;
      setBusy(true);
      setFailedType(undefined);
      try {
        await write();
      } catch {
        setFailedType(rangeType);
        setBusy(false);
        return;
      }
      setEditing(undefined);
      setConfirmingStop(undefined);
      await reload();
      setBusy(false);
      AccessibilityInfo.announceForAccessibility(announcement);
      setFocusTarget({ kind: 'heading', rangeType });
      requestSync();
    },
    [executor, reload, requestSync],
  );

  const adoptTypical = useCallback(
    (view: TargetRangeView) => {
      const suggestion = view.suggestion;
      if (executor === undefined || suggestion === null) return;
      void run(
        view.rangeType,
        () =>
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
        t('common:targetRanges.announceTypical', { measure: measureOf(view.rangeType) }),
      );
    },
    [executor, measureOf, run, t],
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
        const first = result.errors[0];
        if (first !== undefined) setFocusTarget({ kind: first.field, rangeType: view.rangeType });
        return;
      }
      setFormErrors([]);
      const saved = {
        lowValue: result.lowValue === null ? null : Number(result.lowValue),
        highValue: result.highValue === null ? null : Number(result.highValue),
      };
      void run(
        view.rangeType,
        () =>
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
        t('common:targetRanges.announceSet', {
          measure: measureOf(view.rangeType),
          value: valueText(saved, SPOKEN),
        }),
      );
    },
    [executor, highText, lowText, measureOf, profile.measurementSystem, run, t, valueText],
  );

  const stopOwn = useCallback(
    (view: TargetRangeView) => {
      const own = view.patientRange;
      if (executor === undefined || own === null) return;
      // Queued even when the value has not been sent yet: see
      // `enqueueRangeStatusChange` for why cancelling it instead was wrong.
      void run(
        view.rangeType,
        () => enqueueRangeStatusChange(executor, own, 'superseded', clockNow),
        t('common:targetRanges.announceStop', { measure: measureOf(view.rangeType) }),
      );
    },
    [executor, measureOf, run, t],
  );

  const decideProposal = useCallback(
    (view: TargetRangeView, status: 'active' | 'dismissed') => {
      const proposal = view.proposal;
      if (executor === undefined || proposal === null) return;
      void run(
        view.rangeType,
        () => enqueueRangeStatusChange(executor, proposal, status, clockNow),
        t(
          status === 'active'
            ? 'common:targetRanges.announceAccept'
            : 'common:targetRanges.announceDecline',
          { measure: measureOf(view.rangeType) },
        ),
      );
    },
    [executor, measureOf, run, t],
  );

  const openForm = useCallback(
    (view: TargetRangeView) => {
      // Pre-filled with the patient's own range, so changing one side does not
      // mean retyping the other, and a mis-tap costs nothing.
      setLowText(toEditableText(view.patientRange?.lowValue ?? null, profile.measurementSystem));
      setHighText(toEditableText(view.patientRange?.highValue ?? null, profile.measurementSystem));
      setFormErrors([]);
      setConfirmingStop(undefined);
      setEditing(view.rangeType);
      setFocusTarget({ kind: 'low', rangeType: view.rangeType });
    },
    [profile.measurementSystem],
  );

  if (phase !== 'authenticated') return <Redirect href="/login" />;

  const formErrorText = (view: TargetRangeView, field: RangeFormError['field']) => {
    const error = formErrors.find((candidate) => candidate.field === field);
    if (error === undefined) return undefined;
    const limits = effectiveLimits(view.limits);
    switch (error.code) {
      case 'needs-a-bound':
        return t('common:targetRanges.errorNeedsBound');
      case 'not-a-number':
        return t('common:targetRanges.errorNotNumber');
      case 'too-precise':
        return t('common:targetRanges.errorTooPrecise');
      case 'not-positive':
        return t('common:targetRanges.errorNotPositive');
      case 'too-small':
        return t('common:targetRanges.errorTooSmall', { min: amountText(limits.minValue) });
      case 'too-big':
        return t('common:targetRanges.errorTooBig', { max: amountText(limits.maxValue) });
      case 'below-low':
        return t('common:targetRanges.errorBelowLow');
    }
  };

  const unitLong = t(
    profile.measurementSystem === 'imperial'
      ? 'common:targetRanges.unitNameImperial'
      : 'common:targetRanges.unitNameMetric',
  );
  const unitShort = formatVolumeUnitLabel(units.volumeUnit, undefined, 'short');

  return (
    <Screen>
      <Heading>{t('common:targetRanges.heading')}</Heading>
      <BodyText>{t('common:targetRanges.intro')}</BodyText>

      {state.status === 'loading' ? <BodyText>{t('mobile:common.loadingLabel')}</BodyText> : null}
      {state.status === 'never-fetched' ? (
        <>
          <BodyText>{t('common:targetRanges.needsConnection')}</BodyText>
          <Button
            label={t('common:settings.retryButton')}
            variant="secondary"
            busy={isRunning}
            disabled={isRunning}
            onPress={requestSync}
          />
        </>
      ) : null}
      {state.status === 'ready' && state.views.length === 0 ? (
        <BodyText>{t('common:targetRanges.empty')}</BodyText>
      ) : null}

      {state.status === 'ready'
        ? state.views.map((view) => {
            const measure = measureOf(view.rangeType);
            const isEditing = editing === view.rangeType;
            const isConfirmingStop = confirmingStop === view.rangeType;
            const own = view.patientRange;
            const sameAsTypical =
              own !== null &&
              view.suggestion !== null &&
              own.lowValue === view.suggestion.lowValue &&
              own.highValue === view.suggestion.highValue;
            const offerTypical =
              view.suggestion !== null && view.source !== 'physician' && !sameAsTypical;
            const basis = view.basis === null ? null : rangeBasisCopy(view.basis);
            const allowsNegative = (view.limits?.minValue ?? 0) < 0;
            const confirmKey = stopConfirmKey(view);

            return (
              <View key={view.rangeType} style={{ gap: 8 }}>
                <Heading
                  level={2}
                  ref={(node) => {
                    headingRefs.current.set(view.rangeType, node);
                  }}
                >
                  {measure}
                </Heading>
                {view.shown === null ? (
                  <BodyText>{t('common:targetRanges.needsConnectionOne')}</BodyText>
                ) : (
                  <BodyText accessibilityLabel={valueText(view.shown, SPOKEN)}>
                    {valueText(view.shown)}
                  </BodyText>
                )}
                <BodyText tone="muted">{t(SOURCE_KEYS[view.source])}</BodyText>

                {view.source !== 'suggestion' && view.suggestion !== null ? (
                  <BodyText
                    tone="muted"
                    accessibilityLabel={t('common:targetRanges.typical', {
                      value: valueText(view.suggestion, SPOKEN),
                    })}
                  >
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
                    <BodyText
                      accessibilityLabel={t('common:targetRanges.yourValue', {
                        value: valueText(own, SPOKEN),
                      })}
                    >
                      {t('common:targetRanges.yourValue', { value: valueText(own) })}
                    </BodyText>
                    <BodyText>{t('common:targetRanges.divergesFromPhysician')}</BodyText>
                  </>
                ) : null}
                {view.waitingToSend ? (
                  <BodyText tone="muted">{t('common:targetRanges.waitingToSend')}</BodyText>
                ) : null}
                {failedType === view.rangeType ? (
                  <BodyText tone="error" live="assertive">
                    {t('common:targetRanges.saveFailed')}
                  </BodyText>
                ) : null}

                {view.proposal === null ? null : (
                  <>
                    <BodyText
                      accessibilityLabel={t('common:targetRanges.proposal', {
                        value: valueText(view.proposal, SPOKEN),
                      })}
                    >
                      {t('common:targetRanges.proposal', { value: valueText(view.proposal) })}
                    </BodyText>
                    {/* Neither choice is emphasised: §3.9 forbids presenting a
                        suggestion as the one to pick. */}
                    <Button
                      label={t('common:targetRanges.acceptProposalButton')}
                      accessibilityLabel={t('common:targetRanges.acceptProposalSpoken', {
                        measure,
                      })}
                      variant="secondary"
                      disabled={busy}
                      onPress={() => {
                        decideProposal(view, 'active');
                      }}
                    />
                    <Button
                      label={t('common:targetRanges.dismissProposalButton')}
                      accessibilityLabel={t('common:targetRanges.dismissProposalSpoken', {
                        measure,
                      })}
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
                      inputRef={lowInputRef}
                      label={t('common:targetRanges.formLowLabel')}
                      accessibilityLabel={t('common:targetRanges.formLowSpoken', {
                        unit: unitLong,
                        measure,
                      })}
                      value={lowText}
                      onChangeText={setLowText}
                      unitLabel={unitShort}
                      errorMessage={formErrorText(view, 'low')}
                      hint={allowsNegative ? t('common:targetRanges.negativeHint') : undefined}
                      allowsNegative={allowsNegative}
                    />
                    <NumericField
                      inputRef={highInputRef}
                      label={t('common:targetRanges.formHighLabel')}
                      accessibilityLabel={t('common:targetRanges.formHighSpoken', {
                        unit: unitLong,
                        measure,
                      })}
                      value={highText}
                      onChangeText={setHighText}
                      unitLabel={unitShort}
                      errorMessage={formErrorText(view, 'high')}
                      hint={allowsNegative ? t('common:targetRanges.negativeHint') : undefined}
                      allowsNegative={allowsNegative}
                    />
                    <Button
                      label={t('common:targetRanges.formSaveButton')}
                      accessibilityLabel={t('common:targetRanges.formSaveSpoken', { measure })}
                      busy={busy}
                      disabled={busy}
                      onPress={() => {
                        saveOwn(view);
                      }}
                    />
                    <Button
                      label={t('common:targetRanges.formCancelButton')}
                      accessibilityLabel={t('common:targetRanges.formCancelSpoken', { measure })}
                      variant="secondary"
                      onPress={() => {
                        setEditing(undefined);
                        setFormErrors([]);
                        setFocusTarget({ kind: 'heading', rangeType: view.rangeType });
                      }}
                    />
                  </View>
                ) : isConfirmingStop ? (
                  <View style={{ gap: 8 }}>
                    <BodyText live="polite">{t(confirmKey, { measure })}</BodyText>
                    <Button
                      label={t('common:targetRanges.stopConfirmButton')}
                      accessibilityLabel={t('common:targetRanges.stopConfirmSpoken', { measure })}
                      variant="secondary"
                      disabled={busy}
                      onPress={() => {
                        stopOwn(view);
                      }}
                    />
                    <Button
                      label={t('common:targetRanges.stopKeepButton')}
                      accessibilityLabel={t('common:targetRanges.stopKeepSpoken', { measure })}
                      variant="secondary"
                      onPress={() => {
                        setConfirmingStop(undefined);
                        setFocusTarget({ kind: 'heading', rangeType: view.rangeType });
                      }}
                    />
                  </View>
                ) : (
                  <>
                    {offerTypical ? (
                      // Secondary like the others: the typical range is not the
                      // recommended choice, and its numbers are unratified (#130).
                      <Button
                        label={t('common:targetRanges.useTypicalButton')}
                        accessibilityLabel={t('common:targetRanges.useTypicalSpoken', { measure })}
                        hint={t('common:targetRanges.useTypicalHint')}
                        variant="secondary"
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
                      accessibilityLabel={
                        own === null
                          ? t('common:targetRanges.setOwnSpoken', { measure })
                          : t('common:targetRanges.changeOwnSpoken', { measure })
                      }
                      variant="secondary"
                      disabled={busy}
                      onPress={() => {
                        openForm(view);
                      }}
                    />
                    {own === null ? null : (
                      <Button
                        label={t('common:targetRanges.stopOwnButton')}
                        accessibilityLabel={t('common:targetRanges.stopOwnSpoken', { measure })}
                        variant="secondary"
                        disabled={busy}
                        onPress={() => {
                          setEditing(undefined);
                          setConfirmingStop(view.rangeType);
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
          // Back, not a replace: Settings was pushed under this screen, and a
          // replace stacked a fresh copy on top, losing any unsaved edits there.
          if (router.canGoBack()) router.back();
          else router.replace('/settings');
        }}
      />
    </Screen>
  );
}

export default withProfile(TargetRangesScreen);
