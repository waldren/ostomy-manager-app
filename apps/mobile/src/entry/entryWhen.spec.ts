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

import { DateTimePickerAndroid } from '@react-native-community/datetimepicker';

import { combineLocalDateAndTime, earliestPickableDate, uses24HourClock } from './entryWhen';
import { pickDateTime } from './pickDateTime';

/**
 * Every assertion below reads LOCAL parts, never `toISOString()`: these
 * functions work in the runtime's zone on purpose (see `entryWhen.ts`), so a
 * UTC assertion would pass on one developer's machine and fail on the next.
 */
function localParts(date: Date): number[] {
  return [
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
    date.getMilliseconds(),
  ];
}

describe('combineLocalDateAndTime', () => {
  it('takes the day from the first and the time from the second', () => {
    const day = new Date(2026, 9, 7, 15, 45);
    const time = new Date(2026, 9, 8, 2, 10);

    expect(localParts(combineLocalDateAndTime(day, time))).toEqual([2026, 9, 7, 2, 10, 0, 0]);
  });

  /** The dialogs offer no seconds, so none may leak in from the seed value. */
  it('zeroes seconds and milliseconds', () => {
    const seed = new Date(2026, 9, 8, 2, 10, 41, 337);

    expect(localParts(combineLocalDateAndTime(seed, seed)).slice(5)).toEqual([0, 0]);
  });
});

describe('earliestPickableDate', () => {
  /**
   * `new Date('2026-09-01')` is UTC midnight — the evening of Aug 31 for anyone
   * west of UTC, which would offer them a day before their surgery.
   */
  it('is local midnight on the surgery date', () => {
    const earliest = earliestPickableDate('2026-09-01');

    expect(earliest === undefined ? undefined : localParts(earliest)).toEqual([
      2026, 8, 1, 0, 0, 0, 0,
    ]);
  });

  it('is undefined with no surgery date, or one it cannot read', () => {
    expect(earliestPickableDate(null)).toBeUndefined();
    expect(earliestPickableDate('September 1')).toBeUndefined();
  });
});

describe('uses24HourClock', () => {
  it('follows the locale', () => {
    expect(uses24HourClock('en-US')).toBe(false);
    expect(uses24HourClock('en-GB')).toBe(true);
    expect(uses24HourClock('de-DE')).toBe(true);
  });
});

jest.mock('@react-native-community/datetimepicker', () => ({
  DateTimePickerAndroid: { open: jest.fn() },
}));
const mockOpen = jest.mocked(DateTimePickerAndroid.open);

type OpenArgs = Parameters<typeof DateTimePickerAndroid.open>[0];

/** Answers each dialog in turn, as the patient would. */
function answerDialogs(...answers: (Date | 'dismissed')[]): void {
  for (const answer of answers) {
    mockOpen.mockImplementationOnce((args: OpenArgs) => {
      if (answer === 'dismissed') {
        args.onDismiss?.();
      } else {
        args.onValueChange?.(
          { nativeEvent: { timestamp: answer.getTime(), utcOffset: 0 } },
          answer,
        );
      }
    });
  }
}

describe('pickDateTime', () => {
  const options = {
    value: new Date(2026, 9, 8, 12, 0),
    minimumDate: new Date(2026, 8, 1),
    maximumDate: new Date(2026, 9, 8, 12, 0),
  };

  beforeEach(() => {
    mockOpen.mockReset();
  });

  it('asks for the day, then the time, and combines them', async () => {
    answerDialogs(new Date(2026, 9, 7), new Date(2026, 9, 8, 23, 30));

    const picked = await pickDateTime(options);

    expect(picked === undefined ? undefined : localParts(picked)).toEqual([
      2026, 9, 7, 23, 30, 0, 0,
    ]);
    expect(mockOpen.mock.calls.map(([args]) => args.mode)).toEqual(['date', 'time']);
  });

  it('bounds the day dialog, and states the clock format on the time dialog', async () => {
    answerDialogs(new Date(2026, 9, 7), new Date(2026, 9, 8, 23, 30));

    await pickDateTime(options);

    const [dateArgs, timeArgs] = mockOpen.mock.calls.map(([args]) => args);
    expect(dateArgs?.minimumDate).toBe(options.minimumDate);
    expect(dateArgs?.maximumDate).toBe(options.maximumDate);
    // en-US, the locale the field itself formats in.
    expect(timeArgs?.is24Hour).toBe(false);
  });

  it('leaves the lower bound off when there is no surgery date', async () => {
    answerDialogs('dismissed');

    await pickDateTime({ ...options, minimumDate: undefined });

    expect(mockOpen.mock.calls[0]?.[0]).not.toHaveProperty('minimumDate');
  });

  it('changes nothing when the patient backs out of either dialog', async () => {
    answerDialogs('dismissed');
    expect(await pickDateTime(options)).toBeUndefined();
    expect(mockOpen).toHaveBeenCalledTimes(1);

    answerDialogs(new Date(2026, 9, 7), 'dismissed');
    expect(await pickDateTime(options)).toBeUndefined();
  });

  it('changes nothing when a dialog cannot open', async () => {
    mockOpen.mockImplementationOnce((args: OpenArgs) => {
      args.onError?.(new Error('no activity'));
    });

    expect(await pickDateTime(options)).toBeUndefined();
  });
});
