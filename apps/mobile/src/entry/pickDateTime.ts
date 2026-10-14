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

import { DEFAULT_LOCALE } from '@ostomy/core/i18n';
import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';

import { combineLocalDateAndTime, uses24HourClock } from './entryWhen';

/**
 * Asks the patient for a date and then a time, using Android's own dialogs,
 * and resolves to the instant they chose — or `undefined` if they backed out
 * of either step.
 *
 * ## Why the platform dialogs rather than a control of our own
 *
 * The population skews older and post-surgical (CLAUDE.md), and WCAG 2.1 AA is
 * a hard target. The system date and time dialogs already work with TalkBack,
 * follow the system font scale, speak the patient's language and calendar, and
 * are the ones every other app on the phone uses. A hand-built picker would
 * have to earn all four, and nothing in CI can check the first one (Gate B,
 * `docs/gate-b-hardware-verification.md`).
 *
 * Android-only by construction, which matches ADR-0020's v1 scope.
 *
 * Kept as the one module that touches the native API, so a test replaces this
 * function and never has to fake a native dialog.
 */
export async function pickDateTime(options: {
  readonly value: Date;
  readonly minimumDate: Date | undefined;
  readonly maximumDate: Date;
}): Promise<Date | undefined> {
  const day = await openDialog({
    mode: 'date',
    value: options.value,
    ...(options.minimumDate === undefined ? {} : { minimumDate: options.minimumDate }),
    maximumDate: options.maximumDate,
  });
  if (day === undefined) return undefined;

  // No min/max here: Android's time dialog cannot express "not after now, but
  // only on today". A time in the future is caught by Tier 1 on save and
  // reported beside this field, which is a clearer message than a dial that
  // silently refuses to turn.
  const time = await openDialog({
    mode: 'time',
    value: options.value,
    // The locale the field itself formats in, so the dialog and the value it
    // fills in agree on "14:00" versus "2:00 PM".
    is24Hour: uses24HourClock(DEFAULT_LOCALE),
  });
  if (time === undefined) return undefined;

  return combineLocalDateAndTime(day, time);
}

function openDialog(
  args: Omit<
    Parameters<typeof DateTimePickerAndroid.open>[0],
    'onChange' | 'onValueChange' | 'onDismiss' | 'onError'
  >,
): Promise<Date | undefined> {
  return new Promise((resolve) => {
    DateTimePickerAndroid.open({
      ...args,
      // The specific listeners, not the deprecated catch-all `onChange`, which
      // also logs a warning on every open.
      onValueChange: (_event, date) => {
        resolve(date);
      },
      onDismiss: () => {
        resolve(undefined);
      },
      // A dialog that could not open (no foreground activity) changes
      // nothing: the field keeps the value it had, which is never wrong.
      onError: () => {
        resolve(undefined);
      },
    });
  });
}
