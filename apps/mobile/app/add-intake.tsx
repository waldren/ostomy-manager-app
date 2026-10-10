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

import { formatDateTime, formatVolumeQuantity, formatVolumeUnitLabel } from '@ostomy/core/i18n';
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
import {
  VALUE_SET_KEY,
  type CachedValueSetMember,
} from '../src/db/repositories/valueSetsRepository';
import { parseDraftParams } from '../src/quickadd/draftParams';
import { FLUID_INTAKE_LOINC_CODE } from '../src/entry/observationCodes';
import {
  amountError,
  checkEntry,
  methodError,
  toCanonicalValueString,
  type EntryCheck,
} from '../src/entry/useStomaOutputEntry';
import { labelKeyFor, useValueSetOptions } from '../src/entry/useValueSetOptions';
import {
  unitsForMeasurementSystem,
  type MeasurementSystem,
  type MeasurementSystemUnits,
} from '../src/lib/units/measurementSystem';
import { convertVolumeForDisplay, type DisplayVolume } from '@ostomy/core/units';
import { deviceTimeZone, now as clockNow, toWireInstant } from '../src/lib/utils/clock';
import { useSyncStatus } from '../src/sync/SyncProvider';
import { BodyText } from '../src/ui/BodyText';
import { Button } from '../src/ui/Button';
import { ChoiceGroup } from '../src/ui/ChoiceGroup';
import { Heading } from '../src/ui/Heading';
import { NumericField } from '../src/ui/NumericField';
import { Screen } from '../src/ui/Screen';

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
function AddIntakeScreen({ profile }: { readonly profile: LocalProfile }): React.JSX.Element {
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
  const [fluidTypeCode, setFluidTypeCode] = useState<string | undefined>(draft.fluidType);
  const [effectiveDateTime] = useState(() => clockNow());
  const [check, setCheck] = useState<EntryCheck | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  // Destructured so the callbacks below depend on these VALUES rather than on
  // `profile`, whose identity the gate controls.
  const { measurementSystem, surgeryDate } = profile;
  const units = unitsForMeasurementSystem(measurementSystem);
  const containers = useValueSetOptions(VALUE_SET_KEY.CONTAINER_SIZE);
  const fluidTypes = useValueSetOptions(VALUE_SET_KEY.FLUID_TYPE);

  const cached = useCachedThresholds(database);

  const save = useCallback(
    async (confirmedWarning: boolean) => {
      if (database.status !== 'ready' || cached == null) return;

      const outcome = checkEntry({
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
      <Heading>{t('common:entry.intakeHeading')}</Heading>

      {cached === null ? (
        <BodyText tone="error">{t('mobile:entry.thresholdsUnavailableBody')}</BodyText>
      ) : null}

      <NumericField
        label={t('common:entry.intakeAmountLabel')}
        hint={t('common:entry.intakeAmountHint')}
        value={amountText}
        onChangeText={setAmountText}
        unitLabel={formatVolumeUnitLabel(units.volumeUnit)}
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
              .map((member) => ({ member, size: containerSizeFor(member, units) }))
              .filter(
                (entry): entry is { member: CachedValueSetMember; size: DisplayVolume } =>
                  entry.size !== null,
              )
              .map(({ member, size }) => (
                <Button
                  key={member.code}
                  label={formatVolumeQuantity(size)}
                  variant="secondary"
                  onPress={() => {
                    // Auto-fills the field rather than saving: the AC says
                    // "auto-fill the volume field when tapped", and a
                    // one-tap save would skip the Measured/Estimated
                    // choice that Tier 1 requires.
                    //
                    // The CONVERTED number, matching the button's own face.
                    // Filling the canonical millilitre figure into a field
                    // measured in the patient's unit is what made an imperial
                    // patient's tap on "750 fl oz" save about 22 litres.
                    setAmountText(String(size.value));
                  }}
                />
              ))}
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
        <BodyText tone="error" live="assertive">
          {t('common:entry.estimatedUnavailableBody')}
        </BodyText>
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
 * One quick-select container size, in the units the patient reads and types
 * in — or `null` for a member this release cannot place on a button.
 *
 * ## What this is fixing
 *
 * The size was previously rendered as the member's raw canonical number
 * labelled with the patient's unit, and the tap filled the field with that
 * same raw number. Under metric both are right by coincidence: the members
 * are stored in mL and a metric patient reads and types mL. Under imperial
 * the 750 mL bottle rendered as "750 fl oz" — about 22 litres — and tapping
 * it saved that, because the field's contents are read as the patient's unit
 * and converted on save. A one-tap control that writes roughly thirty times
 * the real volume into a hydration signal is the worst kind of defect this
 * screen can have, and it was unreachable until P4.S1 let a patient choose
 * imperial (#122).
 *
 * ## Why the member's own unit, not an assumption
 *
 * `numericUnit` is what the admin configured the set in, and the comment at
 * the call site has always said to use it. A member in a unit this release
 * has no conversion for is dropped rather than guessed at: every other
 * unknown-value case in this codebase renders a generic label and keeps the
 * value visible, but those are review surfaces. This is a button that writes
 * a clinical number, and offering one whose value cannot be computed is worse
 * than not offering it. The typed field beside it still accepts any amount.
 */
function containerSizeFor(
  member: CachedValueSetMember,
  target: MeasurementSystemUnits,
): DisplayVolume | null {
  if (member.numericValue === null) return null;
  const memberSystem = MEASUREMENT_SYSTEM_BY_VOLUME_UNIT[member.numericUnit ?? ''];
  if (memberSystem === undefined) return null;
  return convertVolumeForDisplay(
    member.numericValue,
    unitsForMeasurementSystem(memberSystem),
    target,
  );
}

/**
 * The volume units a member may be configured in, and which system each one
 * makes the member's value canonical to. Deliberately a lookup rather than a
 * cast: a set configured in litres or cups reaches here as an unknown key and
 * is dropped, instead of being read as millilitres.
 */
const MEASUREMENT_SYSTEM_BY_VOLUME_UNIT: Readonly<Record<string, MeasurementSystem | undefined>> = {
  mL: 'metric',
  oz: 'imperial',
};

/**
 * The profile arrives as a prop, never read inside — see `withProfile`. Two
 * fields come off it, and a fallback for either would be worse than not
 * rendering: `measurementSystem` is what every amount is rendered AND recorded
 * as (ADR-0012, permanent per row), and `surgeryDate` is the Tier 1 lower bound
 * that silently stops applying when it is absent.
 */
export default withProfile(AddIntakeScreen);
