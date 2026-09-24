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
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import { discardRejectedCreate, reenqueueCorrectedObservation } from '../src/db/offlineWrites';
import { getObservationById } from '../src/db/repositories/observationsRepository';
import { VALUE_SET_KEY } from '../src/db/repositories/valueSetsRepository';
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
import {
  DEFAULT_MEASUREMENT_SYSTEM,
  unitsForMeasurementSystem,
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

interface RejectedEntry {
  readonly operation: SyncQueueEntry;
  readonly observation: LocalObservation;
}

export default function Corrections(): React.JSX.Element {
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

  const measurementSystem = DEFAULT_MEASUREMENT_SYSTEM;
  const units = unitsForMeasurementSystem(measurementSystem);
  const colors = useValueSetOptions(VALUE_SET_KEY.URINE_COLOR);

  const load = useCallback(async () => {
    if (database.status !== 'ready') return;
    const rejected = await listRejectedOperations(database.executor);
    const resolved: RejectedEntry[] = [];
    for (const operation of rejected) {
      const observation = await getObservationById(database.executor, operation.entityId);
      // A rejected operation whose entity row is gone cannot be rendered or
      // corrected — there is nothing to show the patient and nothing to
      // edit. Skipped rather than rendered as a blank card; the row stays in
      // the queue, so nothing is dropped.
      if (observation !== undefined) resolved.push({ operation, observation });
    }
    setEntries(resolved);
    setCached((await readThresholds(database.executor)) ?? null);
  }, [database]);

  useEffect(() => {
    void load();
  }, [load]);

  const beginEdit = useCallback((entry: RejectedEntry) => {
    setEditing(entry.operation.operationId);
    // Empty only when the row genuinely has no amount — a colour-only urine
    // entry. Every other row has one, and the editor renders the field for it.
    setAmountText(entry.observation.valueQuantityValue ?? '');
    // Decoded from the stored qualifier, not inferred from whether it is null.
    // This used to read `method === null ? 'measured' : 'estimated'`, which
    // since ADR-0018's amendment relabels every MEASURED entry as Estimated
    // the moment a patient opens it to fix something else — a silent change to
    // a clinical claim about how the number was arrived at.
    setMethod(methodFromStoredCode(entry.observation.method));
    setUrineColorCode(entry.observation.urineColorCode ?? undefined);
    setCheck(undefined);
  }, []);

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
            surgeryDate: null,
            now: clockNow(),
          })
        : checkEntry({
            draft: { amountText, method, effectiveDateTime },
            measurementSystem,
            thresholds: cached.thresholds,
            surgeryDate: null,
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
          enteredMeasurementSystem: entry.observation.enteredMeasurementSystem,
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
    [amountText, method, urineColorCode, database, cached, measurementSystem, requestSync, load],
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

  if (phase !== 'authenticated') return <Redirect href="/login" />;

  return (
    <Screen>
      <Heading>{t('common:corrections.heading')}</Heading>

      {entries === undefined ? (
        <BodyText>{t('mobile:common.loadingLabel')}</BodyText>
      ) : entries.length === 0 ? (
        <BodyText>{t('common:corrections.empty')}</BodyText>
      ) : (
        <>
          <BodyText>{t('common:corrections.intro')}</BodyText>
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
                          label={t('common:entry.stomaOutputAmountLabel')}
                          value={amountText}
                          onChangeText={setAmountText}
                          unitLabel={units.volumeUnit}
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
