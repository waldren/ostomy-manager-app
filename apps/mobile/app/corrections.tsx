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
  formatDateTime,
  formatVolumeQuantity,
  formatVolumeUnitLabel,
  rangeBandKey,
  rangeTypeLabelKey,
} from '@ostomy/core/i18n';
import type { MeasuredOrEstimated } from '@ostomy/core/validation';
import { SYNC_REASON_CODE } from '@ostomy/core/sync';
import { Redirect, router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import type { LocalProfile } from '../src/db/repositories/profileRepository';
import { useProfileState } from '../src/onboarding/ProfileProvider';
import { lookUpProfile } from '../src/onboarding/provisionProfile';
import { withProfile } from '../src/onboarding/withProfile';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import {
  discardRejectedCreate,
  discardRejectedQuickAddDecision,
  retryRejectedQuickAddDecision,
  discardRejectedRangeWrite,
  reenqueueCorrectedObservation,
  undoRejectedProfileEdit,
} from '../src/db/offlineWrites';
import { getObservationById } from '../src/db/repositories/observationsRepository';
import {
  getQuickAddDecision,
  type LocalQuickAddDecision,
} from '../src/db/repositories/quickAddDecisionsRepository';
import type { QuickAddSuggestion } from '../src/quickadd/quickAddSuggestions';
import { describeQuickAdd } from '../src/quickadd/QuickAddWidgets';
import {
  getRangeWriteForOperation,
  type RangeWrite,
} from '../src/db/repositories/rangesRepository';
import { VALUE_SET_KEY } from '../src/db/repositories/valueSetsRepository';

/** LOINC 9187-6 — voided urine, whose amount question uses a different noun. */
const VOIDED_URINE_LOINC_CODE = '9187-6';
import { listRejectedOperations } from '../src/db/repositories/syncQueueRepository';
import { readThresholds, type CachedThresholds } from '../src/db/repositories/thresholdsRepository';
import type { LocalObservation, SyncQueueEntry } from '../src/db/types';
import { validationErrorKeyFor } from '../src/entry/rejectionCopy';
import { UrineColorChoice } from '../src/entry/UrineColorChoice';
import {
  amountError,
  checkEntry,
  methodError,
  methodFromStoredCode,
  toCanonicalValueString,
  type EntryCheck,
} from '../src/entry/useStomaOutputEntry';
import { useValueSetOptions } from '../src/entry/useValueSetOptions';
import { checkUrineEntry } from '../src/entry/useVoidedUrineEntry';
import { convertVolumeForDisplay, mlToOz } from '@ostomy/core/units';
import { MAX_VALUE_DECIMAL_PLACES } from '@ostomy/core/validation';
import {
  unitsForMeasurementSystem,
  type MeasurementSystem,
} from '../src/lib/units/measurementSystem';
import { deviceTimeZone, now as clockNow } from '../src/lib/utils/clock';
import { useSyncStatus } from '../src/sync/SyncProvider';
import { BodyText } from '../src/ui/BodyText';
import { Button } from '../src/ui/Button';
import { ChoiceGroup } from '../src/ui/ChoiceGroup';
import { Heading } from '../src/ui/Heading';
import { NumericField } from '../src/ui/NumericField';
import { Screen } from '../src/ui/Screen';

/**
 * The correction inbox — AC 13.1 AC4, and the UI half of
 * `docs/sync-contract.md` §3.5's "retain locally and surface for correction".
 *
 * The storage half already worked: the sync worker marks a rejected operation
 * `rejected` rather than deleting it. Without this screen, though, "surfaced
 * to the patient" was false — the entries sat in a table nothing rendered,
 * which is data loss that merely takes longer to notice.
 *
 * ## Correcting is a new operation, never a retry
 *
 * §9.2 forbids resubmitting a rejected operation unchanged and §9.7 forbids
 * reusing its id, so saving a correction calls
 * `reenqueueCorrectedObservation`, which mints a fresh operation and removes
 * the rejected one in one transaction. See that function for why the
 * operation *type* is preserved.
 *
 * ## An entry with no amount is edited as what it is
 *
 * A colour-only voided-urine entry (P3.S2, AC 12.1 AC2) has no amount and no
 * Measured/Estimated answer, so the editor shows the colour scale instead of
 * the amount field for it. Showing the amount field would ask the patient to
 * fix a number they deliberately did not enter, and reading `null` as an
 * empty string into that field would turn a correction into a blocked save on
 * a rule the entry was never subject to.
 *
 * ## What is never rendered
 *
 * The reason code itself. §6.4: Tier 1 codes resolve to the same
 * plain-language sentences the entry screen uses, and everything else — a
 * non-validation code, a quarantined protocol code, or a code added after
 * this build shipped — becomes one generic message. §6.3 is why the raw
 * identifier is not shown as a fallback: these codes are health facts on
 * their own.
 */

/**
 * A canonical millilitre value, as a number the patient can read AND re-submit.
 *
 * Deliberately NOT `convertVolumeForDisplay`, which is the function every
 * read-only surface uses. That one applies ADR-0005's whole-unit rounding
 * whenever the entry system differs from the display system, and this value is
 * about to be written back: a patient correcting a rejected entry's TIMESTAMP
 * would have had their 354.8824 mL silently rewritten to 355 on the way past.
 * That is ADR-0005's display rounding travelling inward, which CLAUDE.md
 * forbids by name for the Quick-Add path and forbids here for the same reason.
 *
 * Rounded instead to the canonical column's own scale, which kills the float
 * noise from the inverse conversion without inventing precision: a patient who
 * typed 12 fl oz has 354.8824 stored, and `mlToOz` returns 12.000001530084528
 * for it. Showing that in an editable field is its own defect.
 *
 * `apps/mobile/src/quickadd/draftParams.ts` prefills a draft the same way and
 * has the same need; it still uses the display converter.
 */
function editableAmountIn(canonicalMl: number, system: MeasurementSystem): string {
  const inPatientUnits = system === 'imperial' ? mlToOz(canonicalMl) : canonicalMl;
  const factor = 10 ** MAX_VALUE_DECIMAL_PLACES;
  return String(Math.round(inPatientUnits * factor) / factor);
}

/** A refused Quick-Add decision, with this phone's copy of it so the inbox can name the button. */
interface QuickAddRejection {
  readonly operation: SyncQueueEntry;
  readonly decision: LocalQuickAddDecision | undefined;
}

/** §3.8's refusal of a timestamp outside the allowance — the one a patient can fix by retrying. */
const CLOCK_REFUSAL = SYNC_REASON_CODE.CLIENT_TIMESTAMP_OUT_OF_RANGE;

/** A refused range change, with this phone's copy of it so the inbox can say which range. */
interface RangeRejection {
  readonly operation: SyncQueueEntry;
  readonly change: RangeWrite | undefined;
}

interface RejectedEntry {
  readonly operation: SyncQueueEntry;
  readonly observation: LocalObservation;
}

function CorrectionsScreen({ profile }: { readonly profile: LocalProfile }): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation(['common', 'mobile', 'validationErrors']);
  const database = useDatabaseState();
  const { requestSync } = useSyncStatus();

  const [entries, setEntries] = useState<readonly RejectedEntry[] | undefined>(undefined);
  const [cached, setCached] = useState<CachedThresholds | null | undefined>(undefined);
  const [editing, setEditing] = useState<string | undefined>(undefined);
  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<MeasuredOrEstimated | undefined>(undefined);
  const [urineColorCode, setUrineColorCode] = useState<string | undefined>(undefined);
  const [check, setCheck] = useState<EntryCheck | undefined>(undefined);
  /**
   * Rejected profile edits (P4.S3), kept apart from `entries` because they are
   * not entries: there is no amount to fix and no row to delete, only answers
   * to put back the way the server has them.
   */
  const [profileRejections, setProfileRejections] = useState<readonly SyncQueueEntry[]>([]);
  /**
   * Refused target-range changes (P4.S3 slice 4). Not entries either, and with
   * nothing to correct in place: a new range is a new row, set again on the
   * target ranges screen, so the one action is to remove the change.
   */
  const [rangeRejections, setRangeRejections] = useState<readonly RangeRejection[]>([]);
  /** Refused Quick-Add decisions (P4.S3 slice 5b), with one action: remove. */
  const [quickAddRejections, setQuickAddRejections] = useState<readonly QuickAddRejection[]>([]);
  const [undoUnreachable, setUndoUnreachable] = useState(false);
  const { port: profilePort, refresh: refreshProfile } = useProfileState();

  // Destructured so the callbacks below depend on these VALUES rather than on
  // `profile`, whose identity the gate controls.
  const { measurementSystem, surgeryDate } = profile;
  const units = unitsForMeasurementSystem(measurementSystem);
  const colors = useValueSetOptions(VALUE_SET_KEY.URINE_COLOR);

  const load = useCallback(async () => {
    if (database.status !== 'ready') return;
    const rejected = await listRejectedOperations(database.executor);
    const resolved: RejectedEntry[] = [];
    const profiles: SyncQueueEntry[] = [];
    const ranges: RangeRejection[] = [];
    const quickAdds: QuickAddRejection[] = [];
    for (const operation of rejected) {
      if (operation.entityType === 'Profile') {
        profiles.push(operation);
        continue;
      }
      if (operation.entityType === 'QuickAddPreference') {
        quickAdds.push({
          operation,
          decision: await getQuickAddDecision(database.executor, operation.entityId),
        });
        continue;
      }
      if (operation.entityType === 'EffectiveRange') {
        ranges.push({
          operation,
          change: await getRangeWriteForOperation(database.executor, operation.operationId),
        });
        continue;
      }
      const observation = await getObservationById(database.executor, operation.entityId);
      // A rejected operation whose entity row is gone cannot be rendered or
      // corrected — there is nothing to show the patient and nothing to
      // edit. Skipped rather than rendered as a blank card; the row stays in
      // the queue, so nothing is dropped.
      if (observation !== undefined) resolved.push({ operation, observation });
    }
    setEntries(resolved);
    setProfileRejections(profiles);
    setRangeRejections(ranges);
    setQuickAddRejections(quickAdds);
    setCached((await readThresholds(database.executor)) ?? null);
  }, [database]);

  useEffect(() => {
    void load();
  }, [load]);

  const beginEdit = useCallback(
    (entry: RejectedEntry) => {
      setEditing(entry.operation.operationId);
      // Converted into the units this field is LABELLED in, never the stored
      // canonical number.
      //
      // `value_quantity_value` is canonical mL and the save path below reads
      // this field as the patient's current system, so prefilling the raw
      // value made a correction multiply the entry by the conversion factor:
      // a rejected 12 fl oz entry is stored as 354.8824, reopened as
      // "354.8824 fl oz", and confirming it wrote 10,494 mL. It trips the
      // >2,000 mL Tier 2 warning, which is overridable by design, so nothing
      // stopped it. `quickadd/draftParams.ts` is the shape this copies.
      //
      // Empty only when the row genuinely has no amount — a colour-only urine
      // entry. Every other row has one, and the editor renders the field for it.
      setAmountText(
        entry.observation.valueQuantityValue === null
          ? ''
          : editableAmountIn(Number(entry.observation.valueQuantityValue), measurementSystem),
      );
      // Decoded from the stored qualifier, not inferred from whether it is null.
      // This used to read `method === null ? 'measured' : 'estimated'`, which
      // since ADR-0018's amendment relabels every MEASURED entry as Estimated
      // the moment a patient opens it to fix something else — a silent change to
      // a clinical claim about how the number was arrived at.
      setMethod(methodFromStoredCode(entry.observation.method));
      setUrineColorCode(entry.observation.urineColorCode ?? undefined);
      setCheck(undefined);
    },
    [measurementSystem],
  );

  const saveCorrection = useCallback(
    async (entry: RejectedEntry, confirmedWarning: boolean) => {
      if (database.status !== 'ready' || cached == null) return;

      const effectiveDateTime = new Date(entry.observation.effectiveDatetime);
      // Which engine follows from what the ENTRY is, not from what the form
      // currently holds: a colour-only urine entry stays colour-only through a
      // correction, so it keeps the volume-less rule set. `checkUrineEntry`
      // picks between the two the same way the Add Urine screen does, rather
      // than this screen re-deriving which rules stop applying.
      const volumeless = entry.observation.valueQuantityValue === null;
      const outcome = volumeless
        ? checkUrineEntry({
            draft: { amountText: '', method, urineColorCode, effectiveDateTime },
            measurementSystem,
            thresholds: cached.thresholds,
            surgeryDate,
            enteredTimezone: deviceTimeZone(),
            now: clockNow(),
          })
        : checkEntry({
            draft: { amountText, method, effectiveDateTime },
            measurementSystem,
            thresholds: cached.thresholds,
            surgeryDate,
            enteredTimezone: deviceTimeZone(),
            now: clockNow(),
          });
      setCheck(outcome);
      if (outcome.kind === 'blocked' || outcome.kind === 'estimated-unavailable') return;
      if (outcome.kind === 'needs-confirmation' && !confirmedWarning) return;

      // A colour-only entry still has to record something. Guarded here as
      // well as in the render, because this is the branch that decides whether
      // a row with no clinical value at all goes back on the queue.
      if (volumeless && urineColorCode === undefined) return;

      const canonical = volumeless ? null : toCanonicalValueString(amountText, measurementSystem);
      if (!volumeless && (canonical === undefined || method === undefined)) return;

      await reenqueueCorrectedObservation(
        database.executor,
        {
          id: entry.observation.id,
          rejectedOperationId: entry.operation.operationId,
          // Preserved, never assumed. A rejected create must go back as a
          // create; see `reenqueueCorrectedObservation`.
          rejectedOperationType: entry.operation.operationType === 'update' ? 'update' : 'create',
          code: entry.observation.code,
          valueQuantityValue: canonical ?? null,
          // The unit travels with the value in both directions — null when
          // there is no amount, which the local
          // `observations_volume_with_unit` CHECK also requires.
          valueQuantityUnit: volumeless ? null : entry.observation.valueQuantityUnit,
          effectiveDatetime: entry.observation.effectiveDatetime,
          // `null` with no amount: nothing for Measured/Estimated to describe
          // (ADR-0018 amended), and `validateVolumelessObservation` rejects a
          // qualifier there.
          measuredOrEstimated: volumeless ? null : (method ?? null),
          // The patient's CURRENT system, not the rejected row's. They are
          // re-asserting the value by typing it into a field labelled in the
          // system they use today, which is what ADR-0012's field records —
          // and it is what the conversion above and `toCanonicalValueString`
          // below both already assume. Quick-Add states the same rule.
          enteredMeasurementSystem: measurementSystem,
          urineColorCode: urineColorCode ?? null,
          // Carried through from the stored row, because a correction is a
          // full replacement (§4) and this screen offers no control for it.
          // Omitted, `reenqueueCorrectedObservation` writes `null` — so
          // correcting a rejected INTAKE entry's amount silently erased the
          // fluid category the patient chose, locally and then on the server.
          fluidTypeCode: entry.observation.fluidTypeCode,
        },
        clockNow,
      );

      setEditing(undefined);
      requestSync();
      await load();
    },
    [
      amountText,
      method,
      urineColorCode,
      database,
      cached,
      measurementSystem,
      surgeryDate,
      requestSync,
      load,
    ],
  );

  const discard = useCallback(
    async (entry: RejectedEntry) => {
      if (database.status !== 'ready') return;
      await discardRejectedCreate(
        database.executor,
        { id: entry.observation.id, rejectedOperationId: entry.operation.operationId },
        clockNow,
      );
      await load();
    },
    [database, load],
  );

  /**
   * Puts the server's profile back on this phone and drops the rejected edit,
   * together. Online only: the server's copy is the one thing that is certainly
   * right, so with no connection nothing is removed and the patient is told why.
   */
  const undoProfileEdit = useCallback(
    async (operation: SyncQueueEntry) => {
      if (database.status !== 'ready') return;
      const lookup = await lookUpProfile(profilePort);
      if (lookup.status !== 'found') {
        setUndoUnreachable(true);
        return;
      }
      setUndoUnreachable(false);
      await undoRejectedProfileEdit(
        database.executor,
        { rejectedOperationId: operation.operationId, serverProfile: lookup.profile },
        clockNow,
      );
      await refreshProfile();
      await load();
    },
    [database, load, profilePort, refreshProfile],
  );

  const retryQuickAddChange = useCallback(
    async (operation: SyncQueueEntry) => {
      if (database.status !== 'ready') return;
      await retryRejectedQuickAddDecision(
        database.executor,
        { rejectedOperationId: operation.operationId, entityId: operation.entityId },
        clockNow,
      );
      requestSync();
      await load();
    },
    [database, load, requestSync],
  );

  /**
   * The button a refused decision was about, as the patient sees it — and
   * spoken with units in full. `undefined` when this phone no longer holds the
   * decision or cannot name its routine.
   */
  const quickAddLabels = (decision: LocalQuickAddDecision | undefined) => {
    if (decision === undefined) return undefined;
    const { routine } = decision;
    const method = methodFromStoredCode(routine.method);
    const base = {
      key: decision.id,
      routine,
      pinned: false,
      code: routine.code,
      enteredMeasurementSystem: routine.enteredMeasurementSystem,
      occurrences: 0,
      lastEnteredAt: '',
    };
    const suggestion: QuickAddSuggestion | undefined =
      routine.valueMl === null
        ? routine.urineColorCode === null
          ? undefined
          : { ...base, kind: 'volumeless-urine', urineColorCode: routine.urineColorCode }
        : method === undefined
          ? undefined
          : {
              ...base,
              kind: 'volumetric',
              canonicalValue: String(routine.valueMl),
              method,
              fluidTypeCode: routine.fluidTypeCode,
              urineColorCode: routine.urineColorCode,
            };
    if (suggestion === undefined) return undefined;
    const label = describeQuickAdd(suggestion, measurementSystem, t);
    const spoken = describeQuickAdd(suggestion, measurementSystem, t, 'long');
    return label === undefined || spoken === undefined ? undefined : { label, spoken };
  };

  const discardQuickAddChange = useCallback(
    async (operation: SyncQueueEntry) => {
      if (database.status !== 'ready') return;
      await discardRejectedQuickAddDecision(database.executor, {
        rejectedOperationId: operation.operationId,
        entityId: operation.entityId,
      });
      await load();
    },
    [database, load],
  );

  const discardRangeChange = useCallback(
    async (operation: SyncQueueEntry) => {
      if (database.status !== 'ready') return;
      await discardRejectedRangeWrite(database.executor, operation.operationId);
      await load();
    },
    [database, load],
  );

  /**
   * Which range, and what the patient did to it: "Remove this change" is not a
   * decision anyone can make about a change they cannot identify.
   */
  const describeRangeChange = (change: RangeWrite | undefined): string => {
    if (change === undefined) return t('common:corrections.rangeProblem');
    const measure = t(rangeTypeLabelKey(change.rangeType));
    if (change.status === 'superseded') {
      return t('common:corrections.rangeProblemStop', { measure });
    }
    if (change.status === 'dismissed') {
      return t('common:corrections.rangeProblemProposal', { measure });
    }
    const asText = (value: string | null) =>
      value === null
        ? null
        : formatVolumeQuantity(
            convertVolumeForDisplay(Number(value), unitsForMeasurementSystem('metric'), units),
          );
    const key = rangeBandKey({
      hasLow: change.lowValue !== null,
      hasHigh: change.highValue !== null,
    });
    if (key === null) return t('common:corrections.rangeProblem');
    const value = t(key, { low: asText(change.lowValue), high: asText(change.highValue) });
    return t('common:corrections.rangeProblemSet', { measure, value });
  };

  if (phase !== 'authenticated') return <Redirect href="/login" />;

  const nothingToShow = entries !== undefined && entries.length === 0;

  return (
    <Screen>
      <Heading>{t('common:corrections.heading')}</Heading>

      {entries === undefined ? (
        <BodyText>{t('mobile:common.loadingLabel')}</BodyText>
      ) : nothingToShow &&
        profileRejections.length === 0 &&
        rangeRejections.length === 0 &&
        quickAddRejections.length === 0 ? (
        <BodyText>{t('common:corrections.empty')}</BodyText>
      ) : (
        <>
          {profileRejections.map((operation) => (
            <View key={operation.operationId} style={{ gap: 8 }}>
              <BodyText tone="error">
                {operation.rejectedField === 'surgeryDate'
                  ? t('common:corrections.profileSurgeryDateProblem')
                  : t('common:corrections.profileProblem')}
              </BodyText>
              <Button
                label={t('common:corrections.profileUndoButton')}
                hint={t('common:corrections.profileUndoHint')}
                onPress={() => {
                  void undoProfileEdit(operation);
                }}
              />
              <BodyText tone="muted">{t('common:corrections.profileUndoHint')}</BodyText>
              {undoUnreachable ? (
                <BodyText tone="error" live="polite">
                  {t('common:corrections.profileUndoUnreachable')}
                </BodyText>
              ) : null}
            </View>
          ))}
          {quickAddRejections.map(({ operation, decision }) => {
            const named = quickAddLabels(decision);
            // §3.8: a clock refusal is fixed by sending again with the
            // corrected clock, which is the one refusal a patient can fix.
            const clock = operation.rejectedReasonCode === CLOCK_REFUSAL;
            return (
              <View key={operation.operationId} style={{ gap: 8 }}>
                <BodyText tone="error">
                  {named === undefined
                    ? t('common:corrections.quickAddProblemUnnamed')
                    : t('common:corrections.quickAddProblem', { label: named.label })}
                </BodyText>
                {clock ? (
                  <>
                    <BodyText tone="muted">{t('common:corrections.quickAddClockProblem')}</BodyText>
                    <Button
                      label={t('common:corrections.quickAddRetryButton')}
                      accessibilityLabel={
                        named === undefined
                          ? undefined
                          : t('common:corrections.quickAddRetrySpoken', { label: named.spoken })
                      }
                      onPress={() => {
                        void retryQuickAddChange(operation);
                      }}
                    />
                  </>
                ) : null}
                <BodyText tone="muted">{t('common:corrections.quickAddDiscardHint')}</BodyText>
                <Button
                  label={t('common:corrections.quickAddDiscardButton')}
                  variant={clock ? 'secondary' : 'primary'}
                  accessibilityLabel={
                    named === undefined
                      ? undefined
                      : t('common:corrections.quickAddDiscardSpoken', { label: named.spoken })
                  }
                  onPress={() => {
                    void discardQuickAddChange(operation);
                  }}
                />
              </View>
            );
          })}
          {rangeRejections.map(({ operation, change }) => (
            <View key={operation.operationId} style={{ gap: 8 }}>
              <BodyText tone="error">{describeRangeChange(change)}</BodyText>
              {/* Before the button, and only once: as a button hint as well it
                  was read twice, and after the button a sighted reader met it
                  only once they had already decided. */}
              <BodyText tone="muted">{t('common:corrections.rangeDiscardHint')}</BodyText>
              <Button
                label={t('common:corrections.rangeDiscardButton')}
                accessibilityLabel={
                  change === undefined
                    ? undefined
                    : t('common:corrections.rangeDiscardSpoken', {
                        measure: t(rangeTypeLabelKey(change.rangeType)),
                      })
                }
                onPress={() => {
                  void discardRangeChange(operation);
                }}
              />
            </View>
          ))}
          {nothingToShow ? null : <BodyText>{t('common:corrections.intro')}</BodyText>}
          {entries.map((entry) => {
            const key = validationErrorKeyFor(entry.operation.rejectedReasonCode);
            const isEditing = editing === entry.operation.operationId;
            const blocked = isEditing && check?.kind === 'blocked' ? check.errors : [];
            const amountRule = amountError(blocked)?.ruleCode;
            const methodRule = methodError(blocked)?.ruleCode;
            const nothingToRecord =
              entry.observation.valueQuantityValue === null && urineColorCode === undefined;

            return (
              <View key={entry.operation.operationId} style={{ gap: 8 }}>
                <BodyText tone="error">
                  {key === undefined
                    ? t('common:corrections.genericProblem')
                    : t(`validationErrors:${key}`)}
                </BodyText>
                <BodyText tone="muted">
                  {t('common:corrections.savedAt', {
                    when: formatDateTime(new Date(entry.observation.effectiveDatetime), undefined, {
                      timeZone: entry.observation.enteredTimezone || deviceTimeZone(),
                    }),
                  })}
                </BodyText>

                {isEditing ? (
                  <>
                    {/* A colour-only urine entry has no amount and no toggle;
                        it is corrected by changing the colour. */}
                    {entry.observation.valueQuantityValue === null ? (
                      <UrineColorChoice
                        options={colors}
                        value={urineColorCode}
                        onChange={setUrineColorCode}
                      />
                    ) : (
                      <>
                        <NumericField
                          // The label has to match the KIND of entry. This
                          // screen never says which one it is editing, so the
                          // noun in the question is the only signal a patient
                          // gets — and "How much came out?" for a rejected
                          // urine entry points at the wrong body function
                          // entirely. Reachable as soon as a urine entry WITH an
                          // amount is rejected.
                          label={
                            entry.observation.code === VOIDED_URINE_LOINC_CODE
                              ? t('common:entry.urineAmountLabel')
                              : t('common:entry.stomaOutputAmountLabel')
                          }
                          value={amountText}
                          onChangeText={setAmountText}
                          unitLabel={formatVolumeUnitLabel(units.volumeUnit, undefined, 'short')}
                          errorMessage={
                            amountRule === undefined
                              ? undefined
                              : t(`validationErrors:${amountRule}`)
                          }
                        />
                        <ChoiceGroup<MeasuredOrEstimated>
                          label={t('common:entry.methodLabel')}
                          value={method}
                          onChange={setMethod}
                          choices={[
                            { value: 'measured', label: t('common:method.measured') },
                            { value: 'estimated', label: t('common:method.estimated') },
                          ]}
                          errorMessage={
                            methodRule === undefined
                              ? undefined
                              : t(`validationErrors:${methodRule}`)
                          }
                        />
                      </>
                    )}
                    {check?.kind === 'estimated-unavailable' ? (
                      <BodyText tone="error" live="assertive">
                        {t('common:entry.estimatedUnavailableBody')}
                      </BodyText>
                    ) : null}
                    <Button
                      label={
                        check?.kind === 'needs-confirmation'
                          ? t('common:entry.warningConfirmButton')
                          : t('common:entry.saveButton')
                      }
                      // A colour-only entry with its colour cleared records
                      // nothing, and the server refuses it. Same affordance as
                      // the Add Urine screen, not a Tier 1 rule invented here.
                      disabled={nothingToRecord}
                      // A disabled button with no stated reason is a dead
                      // control: this screen disabled Save and rendered no
                      // explanation anywhere, so a patient who cleared the
                      // colour got silence. Hint AND visible text, because a
                      // TalkBack user can switch hints off.
                      hint={nothingToRecord ? t('common:entry.urineNothingToSave') : undefined}
                      onPress={() => {
                        void saveCorrection(entry, check?.kind === 'needs-confirmation');
                      }}
                    />
                    {nothingToRecord ? (
                      <BodyText tone="muted" live="polite">
                        {t('common:entry.urineNothingToSave')}
                      </BodyText>
                    ) : null}
                  </>
                ) : (
                  <>
                    <Button
                      label={t('common:corrections.fixButton')}
                      onPress={() => {
                        beginEdit(entry);
                      }}
                    />
                    <Button
                      label={t('common:corrections.deleteButton')}
                      variant="destructive"
                      hint={t('common:corrections.deleteButton')}
                      onPress={() => {
                        void discard(entry);
                      }}
                    />
                  </>
                )}
              </View>
            );
          })}
        </>
      )}

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
 * The profile arrives as a prop, never read inside — see `withProfile`. Two
 * fields come off it, and a fallback for either would be worse than not
 * rendering: `measurementSystem` is what every amount is rendered AND recorded
 * as (ADR-0012, permanent per row), and `surgeryDate` is the Tier 1 lower bound
 * that silently stops applying when it is absent.
 */
export default withProfile(CorrectionsScreen);
