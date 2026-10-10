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
 * Add Intake's quick-select container sizes, for an imperial patient.
 *
 * Found on a device during #122's emulator pass, and it is the most serious
 * thing that pass turned up. The buttons rendered the member's canonical
 * millilitre figure with the patient's unit appended and no conversion, so the
 * 750 mL bottle read "750 fl oz" — about 22 litres — and tapping it filled the
 * amount field with `750`, which the save path then reads as the patient's
 * unit and converts, storing roughly thirty times the real volume into a
 * hydration signal.
 *
 * Invisible under metric, because the members are stored in mL and a metric
 * patient reads and types mL: the raw number and the converted one are the
 * same number, and the raw unit token and the rendered label are both "mL".
 * That is why `imperialEntry.spec.tsx` beside this file did not catch it, and
 * why both systems are asserted here rather than only the broken one.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../i18n/i18n';

import { act, fireEvent, render, screen } from '@testing-library/react-native';

import AddIntake from '../../app/add-intake';
import { runMigrations } from '../db/migrations';
import { writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import { writeThresholds } from '../db/repositories/thresholdsRepository';
import { writeValueSets, VALUE_SET_KEY } from '../db/repositories/valueSetsRepository';
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

/** One stable object with the executor behind a getter — see `imperialEntry.spec.tsx`. */
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

jest.mock('../lib/utils/clock', () => ({
  now: () => new Date('2026-10-08T12:00:00.000Z'),
  deviceTimeZone: () => 'UTC',
  toWireInstant: (date: Date) => date.toISOString(),
}));

const port: ProfilePort = {
  provision: () => Promise.resolve(METRIC),
  read: () => Promise.resolve(METRIC),
};

const AT = '2026-10-08T12:00:00.000Z';

async function renderScreen(profile: LocalProfile): Promise<void> {
  await writeProfile(mockExecutor, profile, AT);
  await act(async () => {
    render(
      <ProfileProvider port={port}>
        <AddIntake />
      </ProfileProvider>,
    );
  });
}

describe('Add Intake container-size buttons', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-containers-'));
    mockExecutor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(mockExecutor, () => new Date(AT));
    await writeThresholds(
      mockExecutor,
      { softWarningMaxMl: 2000, maxClockSkewMs: 5 * 60 * 1000 },
      AT,
    );
    // The real seeded set, in its real unit: these are the numbers that
    // produced "750 fl oz" on screen.
    await writeValueSets(
      mockExecutor,
      [
        {
          key: VALUE_SET_KEY.CONTAINER_SIZE,
          members: [
            { code: 'small_glass_200', sortOrder: 0, numericValue: 200, numericUnit: 'mL' },
            { code: 'large_bottle_750', sortOrder: 1, numericValue: 750, numericUnit: 'mL' },
          ],
        },
      ],
      AT,
    );
  });

  afterEach(async () => {
    await mockExecutor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  /** 750 mL is about 25 fl oz, and must never read as 750 of them. */
  it('converts a size into the units the patient chose', async () => {
    await renderScreen(IMPERIAL);

    expect(screen.getByText('25 fl oz')).toBeTruthy();
    expect(screen.getByText('7 fl oz')).toBeTruthy();
    expect(screen.queryByText('750 fl oz')).toBeNull();
    expect(screen.queryByText('200 fl oz')).toBeNull();
  });

  it('leaves a metric patient sizes exactly as configured', async () => {
    await renderScreen(METRIC);

    expect(screen.getByText('750 mL')).toBeTruthy();
    expect(screen.getByText('200 mL')).toBeTruthy();
  });

  /**
   * The half with clinical consequence. The field's contents are read as the
   * patient's unit on save, so filling it with the canonical number is what
   * turned one tap into a ~22 litre intake entry.
   */
  it('fills the amount with the number on the button, not the canonical one', async () => {
    await renderScreen(IMPERIAL);

    await act(async () => {
      fireEvent.press(screen.getByLabelText('25 fluid ounces'));
    });

    expect(screen.getByLabelText('How much did you drink?').props.value).toBe('25');
  });

  /**
   * The button's FACE is compact and its spoken name is spelled out.
   *
   * These five are one-tap controls that fill a clinical field, and their
   * visible label is their accessible name unless something overrides it —
   * so "25 fl oz" would be announced "25 F L O Z" to a population that skews
   * older and post-surgical. `apps/web`'s `OutputChart` already makes this
   * distinction; mobile's highest-traffic buttons did not.
   */
  it('says the unit out loud rather than spelling the symbol', async () => {
    await renderScreen(IMPERIAL);

    expect(screen.getByLabelText('25 fluid ounces')).toBeTruthy();
    expect(screen.getByText('25 fl oz')).toBeTruthy();
    expect(screen.queryByLabelText('25 fl oz')).toBeNull();
  });

  /**
   * A set an admin configured in a unit this release has no conversion for is
   * dropped rather than guessed at. Unlike a review surface, this is a button
   * that writes a clinical number — offering one whose value cannot be
   * computed is worse than not offering it, and the typed field still accepts
   * any amount.
   */
  it('omits a size whose unit it cannot interpret, rather than assuming millilitres', async () => {
    await writeValueSets(
      mockExecutor,
      [
        {
          key: VALUE_SET_KEY.CONTAINER_SIZE,
          members: [{ code: 'pint_568', sortOrder: 0, numericValue: 568, numericUnit: 'cups' }],
        },
      ],
      AT,
    );
    await renderScreen(METRIC);

    expect(screen.queryByText(/568/)).toBeNull();
  });

  /**
   * One admin edit to the set's unit drops every button at once, and the
   * heading plus the "tap a size below" hint would then point at nothing.
   * "The set loaded" and "there is something to show" stopped being the same
   * question the moment a member could be dropped.
   */
  it('hides the whole row, heading included, when every size was dropped', async () => {
    await writeValueSets(
      mockExecutor,
      [
        {
          key: VALUE_SET_KEY.CONTAINER_SIZE,
          members: [{ code: 'pint_568', sortOrder: 0, numericValue: 568, numericUnit: 'cups' }],
        },
      ],
      AT,
    );
    await renderScreen(METRIC);

    expect(screen.queryByText('Common sizes')).toBeNull();
  });
});
