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
import { tokens } from '@ostomy/ui/tokens';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, Text, View } from 'react-native';

import { deviceTimeZone } from '../lib/utils/clock';
import { Button } from '../ui/Button';
import { earliestPickableDate } from './entryWhen';
import { pickDateTime } from './pickDateTime';

export interface EntryTimestampFieldProps {
  /** The entry's clinical moment. Starts at the time the screen opened. */
  readonly value: Date;
  readonly onChange: (next: Date) => void;
  /** The patient's surgery date, `YYYY-MM-DD`, so the date dialog starts there. Never the enforcement — see `earliestPickableDate`. */
  readonly surgeryDate: string | null;
  /** Injected so the dialog's "latest day" and "Use right now" read the same clock the screen validates against. */
  readonly now: () => Date;
  /** Tier 1 message when the timestamp is blocking the save (`timestampError`). */
  readonly errorMessage?: string | undefined;
}

/**
 * "When was this?" on every entry screen — SRS §3.1 AC 3: the date and time
 * start at now, "but remain fully editable so the user can backdate an entry"
 * (#135).
 *
 * Until this existed the four screens rendered the time as plain text beside
 * one button that reset it to now, so a bag emptied at 02:00 and logged at
 * 08:00 was recorded at 08:00 — onto the next day's totals whenever the event
 * was before midnight (ADR-0016's `local_date` is the grouping key for Daily
 * Net Fluid Balance). It also left both timestamp rules unreachable from any
 * screen, including P4.S1's surgery-date bound.
 *
 * The time is shown as text and changed through a button rather than being a
 * text box: a typed date is one of the least reliable things a form can ask
 * for, and the platform dialogs (`pickDateTime`) are already accessible.
 */
export function EntryTimestampField({
  value,
  onChange,
  surgeryDate,
  now,
  errorMessage,
}: EntryTimestampFieldProps) {
  const { t } = useTranslation(['common']);
  const labelId = useId();
  const errorId = useId();
  const invalid = errorMessage !== undefined;
  const formatted = formatDateTime(value, undefined, { timeZone: deviceTimeZone() });

  return (
    <View style={styles.container}>
      <Text nativeID={labelId} style={styles.label}>
        {t('common:entry.whenLabel')}
      </Text>
      <Text style={styles.hint}>{t('common:entry.whenHint')}</Text>

      <Text
        style={[styles.value, invalid ? styles.valueInvalid : undefined]}
        accessibilityLabelledBy={labelId}
        aria-invalid={invalid}
        aria-errormessage={invalid ? errorId : undefined}
        // Announced when it changes, because both buttons below change it and
        // neither moves focus: without this a screen-reader user picks a time,
        // the dialog closes, and they hear nothing to confirm what was set.
        accessibilityLiveRegion="polite"
      >
        {formatted}
      </Text>

      {invalid ? (
        <Text nativeID={errorId} style={styles.error} accessibilityLiveRegion="polite" role="alert">
          {errorMessage}
        </Text>
      ) : null}

      <Button
        label={t('common:entry.whenChangeButton')}
        variant="secondary"
        onPress={() => {
          void pickDateTime({
            value,
            minimumDate: earliestPickableDate(surgeryDate),
            maximumDate: now(),
          }).then((picked) => {
            if (picked !== undefined) onChange(picked);
          });
        }}
      />
      <Button
        label={t('common:entry.whenUseNowButton')}
        variant="secondary"
        onPress={() => {
          onChange(now());
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: tokens.spacing.xs },
  label: {
    fontSize: tokens.typography.baseFontSizePx,
    fontWeight: '600',
    color: tokens.color.text,
  },
  hint: {
    fontSize: tokens.typography.baseFontSizePx,
    lineHeight: tokens.typography.baseFontSizePx * tokens.typography.lineHeight,
    color: tokens.color.textMuted,
  },
  value: {
    fontSize: tokens.typography.baseFontSizePx,
    color: tokens.color.text,
  },
  valueInvalid: { color: tokens.color.error, fontWeight: '600' },
  error: {
    fontSize: tokens.typography.baseFontSizePx,
    color: tokens.color.error,
    fontWeight: '600',
  },
});
