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

import { Redirect, router } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../src/auth/AuthContext';
import type { LocalProfile } from '../src/db/repositories/profileRepository';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import { enqueueMealCreate } from '../src/db/offlineWrites';
import { cancelSpan, endSpan, startSpan } from '../src/perf/perfMarks';
import { MEAL_SIZES, type MealSize } from '../src/db/repositories/mealsRepository';
import { VALUE_SET_KEY } from '../src/db/repositories/valueSetsRepository';
import { EntryTimestampField } from '../src/entry/EntryTimestampField';
import { checkMealTimestamp, type MealTimestampCheck } from '../src/entry/mealTimestamp';
import { useCachedThresholds } from '../src/entry/useCachedThresholds';
import { labelKeyFor, useValueSetOptions } from '../src/entry/useValueSetOptions';
import { deviceTimeZone, now as clockNow, toWireInstant } from '../src/lib/utils/clock';
import { withProfile } from '../src/onboarding/withProfile';
import { useSyncStatus } from '../src/sync/SyncProvider';
import { BodyText } from '../src/ui/BodyText';
import { Button } from '../src/ui/Button';
import { ChoiceGroup } from '../src/ui/ChoiceGroup';
import { Heading } from '../src/ui/Heading';
import { Screen } from '../src/ui/Screen';
import { TagGroup } from '../src/ui/TagGroup';
import { TextField } from '../src/ui/TextField';

/**
 * The Add Meal screen (SRS §3.1, AC 2.4).
 *
 * ## No volumetric engine here, and that is not an omission
 *
 * A meal has no value, no unit and no Measured/Estimated toggle, so
 * `@ostomy/core`'s volumetric Tier 1 rules do not apply — which is why this
 * screen does not import `checkEntry`. The two rules a meal IS subject to are
 * about *when* it happened, and since #135 made the time editable a patient
 * can trip both, so they run here before the save (`checkMealTimestamp`). The
 * server re-enforces them regardless (`evaluateEntryTimestamp`).
 *
 * Until #135 this screen ran no validation at all, on the stated grounds that
 * a timestamp read from the clock could be neither in the future nor before the
 * surgery date. That held only because the time could not be changed — which
 * is the reason to check rather than reason about it now.
 *
 * The other client-side rule is AC 2.4 AC2's: **the size is mandatory**, and it
 * starts unanswered. `size` is the only stored representation of that choice,
 * so a default would be indistinguishable afterwards from a deliberate answer
 * — the same argument the Measured/Estimated toggle makes.
 *
 * ## Both optional fields are genuinely optional
 *
 * A patient who taps only "A normal meal" and saves has logged a meal. The
 * description and the tags each say "(optional)" in their label, because a
 * field beside a required one reads as required unless it says otherwise.
 */
function AddMeal({ profile }: { readonly profile: LocalProfile }): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation(['common', 'mobile', 'validationErrors']);
  const database = useDatabaseState();
  const { requestSync } = useSyncStatus();

  const [description, setDescription] = useState('');
  const [size, setSize] = useState<MealSize | undefined>(undefined);
  const [tagCodes, setTagCodes] = useState<readonly string[]>([]);
  const [effectiveDateTime, setEffectiveDateTime] = useState(() => clockNow());
  const [timestampCheck, setTimestampCheck] = useState<MealTimestampCheck | undefined>(undefined);
  const [sizeMissing, setSizeMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const tags = useValueSetOptions(VALUE_SET_KEY.MEAL_TAG);
  const cached = useCachedThresholds(database);
  const { surgeryDate } = profile;

  const save = useCallback(async () => {
    if (database.status !== 'ready') return;

    if (size === undefined) {
      setSizeMissing(true);
      return;
    }
    setSizeMissing(false);

    const outcome = checkMealTimestamp({
      effectiveDateTime,
      surgeryDate,
      enteredTimezone: deviceTimeZone(),
      now: clockNow(),
      thresholds: cached?.thresholds,
    });
    setTimestampCheck(outcome);
    if (outcome.kind !== 'ok') return;

    // P4.S5 (#158): started here, after every validation exit, so a blocked or
    // abandoned save leaves no span open. Inert unless the build sets
    // EXPO_PUBLIC_PERF_MARKS.
    startSpan('save-write');
    startSpan('save-confirmed');
    setSaving(true);
    setSaveFailed(false);
    try {
      await enqueueMealCreate(
        database.executor,
        {
          // Trimmed to null: "" and "no description" are the same fact, and
          // the server normalises them the same way. Keeping two
          // representations means every reader has to handle both.
          description: description.trim().length === 0 ? null : description.trim(),
          size,
          tagCodes,
          effectiveDatetime: toWireInstant(effectiveDateTime),
        },
        clockNow,
      );
    } catch {
      // The local write IS the save (§9.5). If it failed there is nothing to
      // confirm, and telling the patient it worked would be the one lie this
      // screen must never tell.
      setSaving(false);
      setSaveFailed(true);
      cancelSpan('save-write');
      cancelSpan('save-confirmed');
      return;
    }

    endSpan('save-write');
    requestSync();
    router.replace('/home?saved=1');
  }, [description, size, tagCodes, effectiveDateTime, surgeryDate, cached, database, requestSync]);

  if (phase !== 'authenticated') return <Redirect href="/login" />;

  return (
    <Screen>
      <Heading>{t('common:entry.mealHeading')}</Heading>

      <TextField
        label={t('common:entry.mealDescriptionLabel')}
        hint={t('common:entry.mealDescriptionHint')}
        value={description}
        onChangeText={setDescription}
        multiline
      />

      {/* AC 2.4 AC2 — mandatory, and unanswered until the patient answers. */}
      <ChoiceGroup<MealSize>
        label={t('common:entry.mealSizeLabel')}
        value={size}
        onChange={(next) => {
          setSize(next);
          setSizeMissing(false);
        }}
        choices={MEAL_SIZES.map((value) => ({
          value,
          label: t(`common:mealSize.${value}`),
        }))}
        errorMessage={sizeMissing ? t('common:entry.mealSizeRequired') : undefined}
      />

      {/* AC 2.4 AC1 — optional quick-tags. */}
      {tags.status === 'ready' ? (
        <TagGroup
          label={t('common:entry.mealTagsLabel')}
          hint={t('common:entry.mealTagsHint')}
          selected={tagCodes}
          onToggle={(code) => {
            setTagCodes((current) =>
              current.includes(code)
                ? current.filter((existing) => existing !== code)
                : [...current, code],
            );
          }}
          options={tags.members.map((member) => {
            const key = labelKeyFor('mealTag', member.code);
            return {
              value: member.code,
              // A member with no catalog entry is real — an admin can add one
              // after this app ships — and renders as "Another option" rather
              // than as its raw code.
              label: key === undefined ? t('common:entry.unknownOptionLabel') : t(key),
            };
          })}
        />
      ) : tags.status === 'unavailable' ? (
        <BodyText tone="muted">{t('common:entry.optionsUnavailable')}</BodyText>
      ) : null}

      <EntryTimestampField
        value={effectiveDateTime}
        onChange={(next) => {
          setEffectiveDateTime(next);
          setTimestampCheck(undefined);
        }}
        surgeryDate={surgeryDate}
        now={clockNow}
        errorMessage={
          timestampCheck?.kind === 'blocked' && timestampCheck.errors[0] !== undefined
            ? t(`validationErrors:${timestampCheck.errors[0].ruleCode}`)
            : undefined
        }
      />

      {timestampCheck?.kind === 'thresholds-unavailable' ? (
        <BodyText tone="error" live="assertive">
          {t('mobile:entry.thresholdsUnavailableBody')}
        </BodyText>
      ) : null}

      <Button
        label={t('common:entry.mealSaveButton')}
        busy={saving}
        onPress={() => {
          void save();
        }}
      />

      {saveFailed ? <BodyText tone="error">{t('common:entry.saveFailedBody')}</BodyText> : null}
    </Screen>
  );
}

/**
 * The profile arrives as a prop since #135, for the surgery date: a backdated
 * meal is checked against it before the save, and a fallback when it is
 * absent would let the Tier 1 lower bound silently stop applying.
 */
export default withProfile(AddMeal);
