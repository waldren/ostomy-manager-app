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

/**
 * Backdating, through the real entry screens and a real local database (#135,
 * SRS §3.1 AC 3).
 *
 * Until #135 every entry was stamped with the moment the screen opened, so
 * neither timestamp rule could fire from any screen and a bag emptied at 02:00
 * and logged at 08:00 landed on the wrong day's totals. These tests are about
 * what reaches the database, because that is where the harm was: a field that
 * showed the chosen time and then saved "now" would pass every rendering test.
 *
 * The native dialogs are replaced at `pickDateTime`, the one module that
 * touches them, so each test states the instant the patient chose.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../i18n/i18n';

import { en } from '@ostomy/core/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ComponentType } from 'react';

import AddIntake from '../../app/add-intake';
import AddMeal from '../../app/add-meal';
import AddOutput from '../../app/add-output';
import AddUrine from '../../app/add-urine';
import { runMigrations } from '../db/migrations';
import { writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import { writeThresholds } from '../db/repositories/thresholdsRepository';
import type { SqliteExecutor } from '../db/executor';
import { ProfileProvider } from '../onboarding/ProfileProvider';
import type { ProfilePort } from '../onboarding/provisionProfile';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { pickDateTime } from './pickDateTime';

jest.setTimeout(30_000);

const NOW_ISO = '2026-10-08T12:00:00.000Z';

const PROFILE: LocalProfile = {
  ostomyType: 'ileostomy',
  surgeryDate: '2026-09-01',
  measurementSystem: 'metric',
};

const mockAuth = { phase: 'authenticated', getFreshAccessToken: async () => 'token' };
jest.mock('../auth/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

let mockExecutor: SqliteExecutor;

/** One stable object — see `imperialEntry.spec.tsx` for why identity matters here. */
const mockDatabaseState = {
  status: 'ready' as const,
  get executor(): SqliteExecutor {
    return mockExecutor;
  },
};
jest.mock('../db/DatabaseProvider', () => ({
  useDatabaseState: () => mockDatabaseState,
  useDatabase: () => mockDatabaseState.executor,
}));

const mockReplace = jest.fn();
jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    router: { replace: (href: string) => mockReplace(href), push: jest.fn(), back: jest.fn() },
    useLocalSearchParams: () => ({}),
    Redirect: ({ href }: { href: string }) => <Text>{`redirect:${href}`}</Text>,
  };
});

jest.mock('../sync/SyncProvider', () => ({
  useSyncStatus: () => ({ requestSync: jest.fn(), lastRejected: 0, lastStop: undefined }),
}));

jest.mock('../lib/utils/clock', () => ({
  now: () => new Date('2026-10-08T12:00:00.000Z'),
  deviceTimeZone: () => 'UTC',
  toWireInstant: (date: Date) => date.toISOString(),
}));

jest.mock('./pickDateTime', () => ({ pickDateTime: jest.fn() }));
const mockPick = jest.mocked(pickDateTime);

const port: ProfilePort = {
  provision: () => Promise.resolve(PROFILE),
  read: () => Promise.resolve(PROFILE),
};

async function renderScreen(Screen: ComponentType): Promise<void> {
  await writeProfile(mockExecutor, PROFILE, NOW_ISO);
  await act(async () => {
    render(
      <ProfileProvider port={port}>
        <Screen />
      </ProfileProvider>,
    );
  });
}

async function type(label: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText(label), value);
  });
}

async function press(label: string): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(label));
  });
}

/** The patient opens the dialogs and lands on `iso` (or backs out, for `undefined`). */
async function chooseTime(iso: string | undefined): Promise<void> {
  mockPick.mockResolvedValueOnce(iso === undefined ? undefined : new Date(iso));
  await press(en.common['entry.whenChangeButton']);
}

interface StoredRow {
  effective_datetime: string;
  local_date: string;
}

function storedObservations(): Promise<StoredRow[]> {
  return mockExecutor.getAllAsync<StoredRow>(
    'SELECT effective_datetime, local_date FROM observations;',
  );
}

function storedMeals(): Promise<StoredRow[]> {
  return mockExecutor.getAllAsync<StoredRow>('SELECT effective_datetime, local_date FROM meals;');
}

let dir: string;

beforeEach(async () => {
  mockPick.mockReset();
  mockReplace.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-backdating-'));
  mockExecutor = createNodeSqliteExecutor(join(dir, 'test.db'));
  await runMigrations(mockExecutor, () => new Date(NOW_ISO));
  await writeThresholds(
    mockExecutor,
    { softWarningMaxMl: 2000, maxClockSkewMs: 5 * 60 * 1000 },
    NOW_ISO,
  );
});

afterEach(async () => {
  await mockExecutor.closeAsync();
  rmSync(dir, { recursive: true, force: true });
});

describe('Add Output', () => {
  async function fillValidOutput(): Promise<void> {
    await type(en.common['entry.stomaOutputAmountLabel'], '350');
    await press(en.common['method.measured']);
  }

  /**
   * The case the issue describes: an event before midnight, logged after it.
   * Stamped "now" it would sit on the 8th; it happened on the 7th, and
   * `local_date` is what every daily total groups by (ADR-0016).
   */
  it('saves the chosen time, onto the day the event happened', async () => {
    await renderScreen(AddOutput);
    await chooseTime('2026-10-07T23:30:00.000Z');
    await fillValidOutput();
    await press(en.common['entry.saveButton']);

    const rows = await storedObservations();
    expect(rows).toEqual([
      { effective_datetime: '2026-10-07T23:30:00.000Z', local_date: '2026-10-07' },
    ]);
    expect(mockReplace).toHaveBeenCalledWith('/home?saved=1');
  });

  it('shows the chosen time on the screen before the save', async () => {
    await renderScreen(AddOutput);
    await chooseTime('2026-10-07T23:30:00.000Z');

    expect(screen.getByText(/Oct 7, 2026/)).toBeTruthy();
  });

  /**
   * P4.S1 exit criterion 3, finally reachable from a screen: the surgery date
   * is the Tier 1 lower bound. The message sits beside the date-and-time field
   * and NOT under the amount, which is perfectly fine.
   */
  it('refuses a time before the surgery date, beside the date field, and saves nothing', async () => {
    await renderScreen(AddOutput);
    await chooseTime('2026-08-31T12:00:00.000Z');
    await fillValidOutput();
    await press(en.common['entry.saveButton']);

    expect(screen.getByText(en.validationErrors.EFFECTIVE_DATE_TIME_BEFORE_SURGERY)).toBeTruthy();
    expect(await storedObservations()).toEqual([]);
    expect(
      screen.getByLabelText(en.common['entry.stomaOutputAmountLabel']).props,
    ).not.toMatchObject({ 'aria-invalid': true });
  });

  it('accepts the surgery day itself', async () => {
    await renderScreen(AddOutput);
    await chooseTime('2026-09-01T00:10:00.000Z');
    await fillValidOutput();
    await press(en.common['entry.saveButton']);

    expect(await storedObservations()).toHaveLength(1);
  });

  /** The date dialog stops at today, but a later time TODAY is still choosable; Tier 1 is what refuses it. */
  it('refuses a time later today, beyond the clock-skew allowance', async () => {
    await renderScreen(AddOutput);
    await chooseTime('2026-10-08T18:00:00.000Z');
    await fillValidOutput();
    await press(en.common['entry.saveButton']);

    expect(screen.getByText(en.validationErrors.EFFECTIVE_DATE_TIME_IN_FUTURE)).toBeTruthy();
    expect(await storedObservations()).toEqual([]);
  });

  it('keeps the time it had when the patient backs out of the dialog', async () => {
    await renderScreen(AddOutput);
    await chooseTime('2026-10-07T23:30:00.000Z');
    await chooseTime(undefined);
    await fillValidOutput();
    await press(en.common['entry.saveButton']);

    expect((await storedObservations())[0]?.effective_datetime).toBe('2026-10-07T23:30:00.000Z');
  });

  it('puts the time back to now on "Use right now"', async () => {
    await renderScreen(AddOutput);
    await chooseTime('2026-10-07T23:30:00.000Z');
    await press(en.common['entry.whenUseNowButton']);
    await fillValidOutput();
    await press(en.common['entry.saveButton']);

    expect((await storedObservations())[0]?.effective_datetime).toBe(NOW_ISO);
  });

  /** A convenience bound only — the rule above is what enforces it — but it should start the dialog on the right days. */
  it('opens the dialog between the surgery day and now, at the current value', async () => {
    await renderScreen(AddOutput);
    await chooseTime(undefined);

    expect(mockPick).toHaveBeenCalledTimes(1);
    const options = mockPick.mock.calls[0]?.[0];
    expect(options?.value.toISOString()).toBe(NOW_ISO);
    expect(options?.maximumDate.toISOString()).toBe(NOW_ISO);
    const minimum = options?.minimumDate;
    expect([minimum?.getFullYear(), minimum?.getMonth(), minimum?.getDate()]).toEqual([2026, 8, 1]);
  });
});

/**
 * One backdated save through each of the other volumetric screens. They share
 * the field, but each owns its own state and its own save, and "the field
 * shows it but the screen saves `now`" is exactly a per-screen mistake.
 */
describe.each([
  { name: 'Add Intake', Screen: AddIntake, amountLabel: en.common['entry.intakeAmountLabel'] },
  { name: 'Add Urine', Screen: AddUrine, amountLabel: en.common['entry.urineAmountLabel'] },
])('$name', ({ Screen, amountLabel }) => {
  it('saves the chosen time', async () => {
    await renderScreen(Screen);
    await chooseTime('2026-10-07T23:30:00.000Z');
    await type(amountLabel, '250');
    await press(en.common['method.measured']);
    await press(en.common['entry.saveButton']);

    expect(await storedObservations()).toEqual([
      { effective_datetime: '2026-10-07T23:30:00.000Z', local_date: '2026-10-07' },
    ]);
  });

  it('refuses a time before the surgery date', async () => {
    await renderScreen(Screen);
    await chooseTime('2026-08-31T12:00:00.000Z');
    await type(amountLabel, '250');
    await press(en.common['method.measured']);
    await press(en.common['entry.saveButton']);

    // Exactly once: Add Urine also has a catch-all for errors no field
    // claimed, and a timestamp error must not render twice.
    expect(
      screen.getAllByText(en.validationErrors.EFFECTIVE_DATE_TIME_BEFORE_SURGERY),
    ).toHaveLength(1);
    expect(await storedObservations()).toEqual([]);
  });
});

/**
 * Add Meal ran no client validation at all until #135, because its time could
 * not be changed. Without the check, a meal dated before surgery would save
 * locally and come back from the server into the correction inbox.
 */
describe('Add Meal', () => {
  async function chooseSize(): Promise<void> {
    await press(en.common['mealSize.medium']);
  }

  it('saves the chosen time', async () => {
    await renderScreen(AddMeal);
    await chooseTime('2026-10-07T23:30:00.000Z');
    await chooseSize();
    await press(en.common['entry.mealSaveButton']);

    expect(await storedMeals()).toEqual([
      { effective_datetime: '2026-10-07T23:30:00.000Z', local_date: '2026-10-07' },
    ]);
  });

  it('refuses a time before the surgery date and saves nothing', async () => {
    await renderScreen(AddMeal);
    await chooseTime('2026-08-31T12:00:00.000Z');
    await chooseSize();
    await press(en.common['entry.mealSaveButton']);

    expect(screen.getByText(en.validationErrors.EFFECTIVE_DATE_TIME_BEFORE_SURGERY)).toBeTruthy();
    expect(await storedMeals()).toEqual([]);
  });

  it('refuses a time later today', async () => {
    await renderScreen(AddMeal);
    await chooseTime('2026-10-08T18:00:00.000Z');
    await chooseSize();
    await press(en.common['entry.mealSaveButton']);

    expect(screen.getByText(en.validationErrors.EFFECTIVE_DATE_TIME_IN_FUTURE)).toBeTruthy();
    expect(await storedMeals()).toEqual([]);
  });

  describe('with no thresholds on this phone yet', () => {
    beforeEach(async () => {
      await mockExecutor.runAsync('DELETE FROM validation_thresholds_cache;');
    });

    /** Before #135 a meal never needed the cache, and an ordinary one still must not. */
    it('still saves a meal at a past time', async () => {
      await renderScreen(AddMeal);
      await chooseTime('2026-10-07T23:30:00.000Z');
      await chooseSize();
      await press(en.common['entry.mealSaveButton']);

      expect(await storedMeals()).toHaveLength(1);
    });

    it('still refuses a time before the surgery date, which needs no threshold', async () => {
      await renderScreen(AddMeal);
      await chooseTime('2026-08-31T12:00:00.000Z');
      await chooseSize();
      await press(en.common['entry.mealSaveButton']);

      expect(screen.getByText(en.validationErrors.EFFECTIVE_DATE_TIME_BEFORE_SURGERY)).toBeTruthy();
      expect(await storedMeals()).toEqual([]);
    });

    /** Undecidable without the allowance, so refused — never checked against a made-up number. */
    it('refuses a future time it cannot check', async () => {
      await renderScreen(AddMeal);
      await chooseTime('2026-10-08T18:00:00.000Z');
      await chooseSize();
      await press(en.common['entry.mealSaveButton']);

      expect(screen.getByText(en.mobile['entry.thresholdsUnavailableBody'])).toBeTruthy();
      expect(await storedMeals()).toEqual([]);
    });
  });
});
