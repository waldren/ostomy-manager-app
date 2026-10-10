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
 * The imperial path, through a real screen (P4.S1 slice 3, exit criterion 4).
 *
 * ADR-0004's imperial rendering and ADR-0005's conversion rounding have been
 * implemented and unit-tested since P2.S2b, and **unreachable in the running app
 * the whole time**: `DEFAULT_MEASUREMENT_SYSTEM` was the constant `'metric'`, so
 * nothing could select the other branch. This slice is the first time a patient
 * can, and #122 flagged it as the slice most likely to find something downstream
 * that assumed metric. These tests are that search, run against the real Add
 * Output screen and a real local database.
 *
 * Three properties, each of which would be silently wrong rather than loud:
 *
 * 1. The unit the patient sees is theirs, not the canonical one.
 * 2. What is STORED is canonical millilitres, rounded to the column's scale —
 *    `ozToMl(80)` is `2365.882365`, and un-rounded Tier 1 refuses every imperial
 *    entry with a message about decimal places the patient never typed.
 * 3. `entered_measurement_system` records `imperial`, which ADR-0012 makes
 *    permanent per row: "no later migration can recover the truth if it is stored
 *    wrongly."
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../i18n/i18n';

import { en } from '@ostomy/core/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import AddOutput from '../../app/add-output';
import { runMigrations } from '../db/migrations';
import { writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import { writeThresholds } from '../db/repositories/thresholdsRepository';
import type { SqliteExecutor } from '../db/executor';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { ProfileProvider } from './ProfileProvider';
import type { ProfilePort } from './provisionProfile';

jest.setTimeout(30_000);

const IMPERIAL: LocalProfile = {
  ostomyType: 'ileostomy',
  surgeryDate: '2026-09-01',
  measurementSystem: 'imperial',
};
const METRIC: LocalProfile = { ...IMPERIAL, measurementSystem: 'metric' };

const mockAuth = { phase: 'authenticated', getFreshAccessToken: async () => 'token' };
jest.mock('../auth/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

let mockExecutor: SqliteExecutor;

/**
 * One stable object, with the executor behind a getter.
 *
 * Identity matters: the screens pass this value into hooks that key effects on
 * it, and in production the real context value is recreated only when
 * `DatabaseProvider` itself re-renders. A mock returning a fresh literal per call
 * instead re-fires those effects on every render — which here meant an unbounded
 * render loop that ended in `JavaScript heap out of memory`, a failure that looks
 * like a product defect and is not.
 */
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

jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
    useLocalSearchParams: () => ({}),
    Redirect: ({ href }: { href: string }) => <Text>{`redirect:${href}`}</Text>,
  };
});

const mockRequestSync = jest.fn();
jest.mock('../sync/SyncProvider', () => ({
  useSyncStatus: () => ({ requestSync: mockRequestSync, lastRejected: 0, lastStop: undefined }),
}));

/** A fixed clock, so the entry's timestamp and the surgery-date bound are both stated rather than inherited. */
jest.mock('../lib/utils/clock', () => ({
  now: () => new Date('2026-10-08T12:00:00.000Z'),
  deviceTimeZone: () => 'UTC',
  toWireInstant: (date: Date) => date.toISOString(),
}));

const port: ProfilePort = {
  provision: () => Promise.resolve(METRIC),
  read: () => Promise.resolve(METRIC),
};

async function renderScreen(profile: LocalProfile): Promise<void> {
  await writeProfile(mockExecutor, profile, '2026-10-08T12:00:00.000Z');
  await act(async () => {
    render(
      <ProfileProvider port={port}>
        <AddOutput />
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

interface StoredObservation {
  value_quantity_value: string;
  value_quantity_unit: string;
  entered_measurement_system: string;
}

async function storedObservations(): Promise<StoredObservation[]> {
  return mockExecutor.getAllAsync<StoredObservation>(
    'SELECT value_quantity_value, value_quantity_unit, entered_measurement_system FROM observations;',
  );
}

describe('Add Output for an imperial patient', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-imperial-'));
    mockExecutor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(mockExecutor, () => new Date('2026-10-08T12:00:00.000Z'));
    // The cache is deliberately unseeded in production, and an unfetched cache
    // refuses the save — so a test about saving has to fill it.
    await writeThresholds(
      mockExecutor,
      { softWarningMaxMl: 2000, maxClockSkewMs: 5 * 60 * 1000 },
      '2026-10-08T12:00:00.000Z',
    );
  });

  afterEach(async () => {
    await mockExecutor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * "fl oz", not "oz", and this assertion is the corrected version of one that
   * passed against the defect.
   *
   * The screen rendered the raw `VolumeUnit` token as its suffix. Under metric
   * the token and CLDR's short form are both "mL", so it was indistinguishable
   * from correct for as long as metric was the only reachable system; under
   * imperial it produced "oz", while every formatted quantity elsewhere in the
   * app says "fl oz". An ounce reads as a measure of weight to most people,
   * which is the ambiguity CLDR's "fl oz" exists to remove, and this is the one
   * place a patient is typing a clinical number. Found on a device during
   * #122's emulator pass, not here, because this test asserted the token.
   */
  it('labels the amount in the patient’s own unit', async () => {
    await renderScreen(IMPERIAL);

    expect(screen.getByText('fl oz')).toBeTruthy();
    expect(screen.queryByText('oz')).toBeNull();
    expect(screen.queryByText('mL')).toBeNull();
  });

  it('still labels it mL for a metric patient — the same screen, the other branch', async () => {
    await renderScreen(METRIC);

    expect(screen.getByText('mL')).toBeTruthy();
    expect(screen.queryByText('fl oz')).toBeNull();
  });

  /**
   * The case that would have blocked every imperial entry.
   *
   * `ozToMl(12)` is `354.88235475`: eight fractional digits, which Tier 1 correctly
   * refuses as unstorable in `DECIMAL(12,4)`. The rounding exists and is
   * unit-tested; what has never been true until now is that a patient could reach
   * it.
   *
   * Twelve ounces rather than eighty, so this asserts the conversion alone — 80 oz
   * is over the Tier 2 warning bound and would need a confirmation step, which is
   * the subject of its own test below rather than noise in this one.
   */
  it('saves an ounce entry as canonical millilitres, rounded to the column’s scale', async () => {
    await renderScreen(IMPERIAL);

    await type(en.common['entry.stomaOutputAmountLabel'], '12');
    await press(en.common['method.measured']);
    await press(en.common['entry.saveButton']);

    const rows = await storedObservations();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.value_quantity_value)).toBe(354.8824);
    expect(rows[0]?.value_quantity_unit).toBe('mL');
  });

  /**
   * ADR-0012: the column records what the PATIENT asserted, and is permanent per
   * row. A screen that rendered oz and then wrote `metric` provenance would be
   * undetectable afterwards — which is why `DEFAULT_MEASUREMENT_SYSTEM` is deleted
   * rather than left as a fallback.
   */
  it('records imperial as the entered measurement system', async () => {
    await renderScreen(IMPERIAL);

    await type(en.common['entry.stomaOutputAmountLabel'], '12');
    await press(en.common['method.measured']);
    await press(en.common['entry.saveButton']);

    const rows = await storedObservations();
    expect(rows[0]?.entered_measurement_system).toBe('imperial');
  });

  it('records metric for a metric patient entering the same number', async () => {
    await renderScreen(METRIC);

    await type(en.common['entry.stomaOutputAmountLabel'], '12');
    await press(en.common['method.measured']);
    await press(en.common['entry.saveButton']);

    const rows = await storedObservations();
    expect(rows[0]?.entered_measurement_system).toBe('metric');
    // 12 mL, not 12 oz converted. The same keystrokes mean a thirtyfold difference
    // in volume, which is exactly why the provenance column exists.
    expect(Number(rows[0]?.value_quantity_value)).toBe(12);
  });

  /**
   * The Tier 2 warning is a canonical-mL bound, so an imperial entry has to be
   * converted BEFORE it is compared. Un-converted, `80` is nowhere near 2,000 and
   * the >2,000 mL warning would never fire for an imperial patient — the defect
   * `@ostomy/core/validation`'s own tier2 comment records having been made once.
   *
   * 80 oz is ~2,366 mL, which is over the threshold, so this entry must ask for
   * confirmation rather than saving straight away.
   */
  it('compares the Tier 2 warning against converted millilitres, not the typed number', async () => {
    await renderScreen(IMPERIAL);

    await type(en.common['entry.stomaOutputAmountLabel'], '80');
    await press(en.common['method.measured']);
    await press(en.common['entry.saveButton']);

    expect(screen.getByText(en.common['entry.warningHeading'])).toBeTruthy();
    // Nothing saved yet: a Tier 2 warning asks, and the patient has not answered.
    await expect(storedObservations()).resolves.toHaveLength(0);
  });

  it('saves on confirmation, because a warning must never block (AC 13.2 AC1)', async () => {
    await renderScreen(IMPERIAL);

    await type(en.common['entry.stomaOutputAmountLabel'], '80');
    await press(en.common['method.measured']);
    await press(en.common['entry.saveButton']);
    await press(en.common['entry.warningConfirmButton']);

    const rows = await storedObservations();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entered_measurement_system).toBe('imperial');
  });

  /** A patient with no profile cannot be asked for an entry — there is no unit to render it in. */
  it('sends a patient with no profile to onboarding rather than guessing a unit', async () => {
    await act(async () => {
      render(
        <ProfileProvider port={{ ...port, read: () => Promise.reject(new Error('offline')) }}>
          <AddOutput />
        </ProfileProvider>,
      );
    });

    expect(screen.getByText('redirect:/onboarding')).toBeTruthy();
  });
});
