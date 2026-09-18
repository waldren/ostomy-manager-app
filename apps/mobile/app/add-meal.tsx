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
import { Redirect, router } from 'expo-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { useDatabaseState } from '../src/db/DatabaseProvider';
import { enqueueMealCreate } from '../src/db/offlineWrites';
import { MEAL_SIZES, type MealSize } from '../src/db/repositories/mealsRepository';
import { VALUE_SET_KEY } from '../src/db/repositories/valueSetsRepository';
import { labelKeyFor, useValueSetOptions } from '../src/entry/useValueSetOptions';
import { deviceTimeZone, now as clockNow, toWireInstant } from '../src/lib/utils/clock';
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
 * ## No validation engine here, and that is not an omission
 *
 * A meal has no value, no unit and no Measured/Estimated toggle, so
 * `@ostomy/core`'s volumetric Tier 1 rules do not apply — which is why this
 * screen does not import `checkEntry`. The two rules a meal IS subject to are
 * about *when* it happened, and this screen cannot trip either: the timestamp
 * is read from the clock at mount and is not editable yet, so it can be
 * neither in the future nor before the surgery date. The server re-enforces
 * both regardless (`evaluateEntryTimestamp`), which is what makes that safe
 * rather than merely convenient.
 *
 * The one client-side rule is AC 2.4 AC2's: **the size is mandatory**, and it
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
export default function AddMeal(): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation(['common', 'mobile']);
  const database = useDatabaseState();
  const { requestSync } = useSyncStatus();

  const [description, setDescription] = useState('');
  const [size, setSize] = useState<MealSize | undefined>(undefined);
  const [tagCodes, setTagCodes] = useState<readonly string[]>([]);
  const [effectiveDateTime] = useState(() => clockNow());
  const [sizeMissing, setSizeMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const tags = useValueSetOptions(VALUE_SET_KEY.MEAL_TAG);

  const save = useCallback(async () => {
    if (database.status !== 'ready') return;

    if (size === undefined) {
      setSizeMissing(true);
      return;
    }
    setSizeMissing(false);

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
      return;
    }

    requestSync();
    router.replace('/home?saved=1');
  }, [description, size, tagCodes, effectiveDateTime, database, requestSync]);

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

      <View>
        <BodyText>{t('common:entry.whenLabel')}</BodyText>
        <BodyText>
          {formatDateTime(effectiveDateTime, undefined, { timeZone: deviceTimeZone() })}
        </BodyText>
      </View>

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
