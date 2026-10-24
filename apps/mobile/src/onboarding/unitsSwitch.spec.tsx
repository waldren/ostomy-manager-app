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
 * Switching units re-renders, and rewrites nothing (P4.S4 slice 2, #154;
 * SRS §3.10; ADR-0004, ADR-0005, ADR-0012).
 *
 * The half of the goal no test held until now. `settingsScreen.spec.tsx`
 * proves the profile changed and an update was queued; nothing proved the
 * entries were left alone. That is the half that cannot be repaired later:
 * a canonical value rewritten on a switch, or an `entered_measurement_system`
 * changed to the new preference, is permanent per row (ADR-0012), and nothing
 * afterwards could tell which rows had been touched.
 *
 * Real screens and a real database. The entries are written by the app's own
 * write functions, so every column holds what it holds on a phone, and the
 * comparison is over every column, so a column added later is covered too.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../i18n/i18n';

import { en } from '@ostomy/core/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { View } from 'react-native';

import Settings from '../../app/settings';
import type { SqliteExecutor } from '../db/executor';
import { runMigrations } from '../db/migrations';
import {
  enqueueVolumelessUrineCreate,
  enqueueVolumetricObservationCreate,
} from '../db/offlineWrites';
import { writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import { writeThresholds } from '../db/repositories/thresholdsRepository';
import {
  FLUID_INTAKE_LOINC_CODE,
  STOMA_OUTPUT_LOINC_CODE,
  VOIDED_URINE_LOINC_CODE,
} from '../entry/observationCodes';
import { QuickAddWidgets } from '../quickadd/QuickAddWidgets';
import { useQuickAddSuggestions } from '../quickadd/useQuickAddSuggestions';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { ProfileProvider, useProfile } from './ProfileProvider';
import type { ProfilePort } from './provisionProfile';

jest.setTimeout(30_000);

const NOW_ISO = '2026-10-08T12:00:00.000Z';

const PROFILE: LocalProfile = {
  ostomyType: 'ileostomy',
  surgeryDate: '2026-09-01',
  measurementSystem: 'metric',
  serverId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b',
};

const mockAuth = { phase: 'authenticated', getFreshAccessToken: async () => 'token' };
jest.mock('../auth/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

let mockExecutor: SqliteExecutor;
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
  const { Text: RNText } = jest.requireActual('react-native');
  return {
    router: { replace: jest.fn(), push: jest.fn(), back: jest.fn() },
    useLocalSearchParams: () => ({}),
    Redirect: ({ href }: { href: string }) => <RNText>{`redirect:${href}`}</RNText>,
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

const port: ProfilePort = {
  provision: () => Promise.resolve(PROFILE),
  read: () => Promise.resolve(PROFILE),
};

/**
 * The dashboard's Quick-Add buttons, as the home screen builds them: from the
 * stored entries, in the profile's current units. A surface that renders a
 * STORED volume, which is what "re-renders history" has to reach.
 */
function StoredVolumes(): React.JSX.Element | null {
  const profile = useProfile();
  const { suggestions } = useQuickAddSuggestions(mockDatabaseState);
  if (profile === undefined) return null;
  return (
    <View>
      <QuickAddWidgets
        suggestions={suggestions}
        measurementSystem={profile.measurementSystem}
        onLog={() => {}}
        onEdit={() => {}}
      />
    </View>
  );
}

const fixedNow = () => new Date(NOW_ISO);

/** One of each shape a stored volume can take, in both systems. */
async function writeEntries(): Promise<void> {
  // A metric routine, twice, so it becomes a Quick-Add button.
  for (const day of ['2026-10-06', '2026-10-07']) {
    await enqueueVolumetricObservationCreate(
      mockExecutor,
      {
        code: STOMA_OUTPUT_LOINC_CODE,
        valueQuantityValue: '350',
        valueQuantityUnit: 'mL',
        effectiveDatetime: `${day}T09:00:00.000Z`,
        measuredOrEstimated: 'measured',
        enteredMeasurementSystem: 'metric',
      },
      fixedNow,
    );
  }
  // Typed as 12 fl oz: the stored value is its rounded canonical conversion,
  // and the row records that it was entered in ounces.
  await enqueueVolumetricObservationCreate(
    mockExecutor,
    {
      code: FLUID_INTAKE_LOINC_CODE,
      valueQuantityValue: '354.8824',
      valueQuantityUnit: 'mL',
      effectiveDatetime: '2026-10-07T10:00:00.000Z',
      measuredOrEstimated: 'estimated',
      enteredMeasurementSystem: 'imperial',
    },
    fixedNow,
  );
  // No volume at all, the one observation that may have none.
  await enqueueVolumelessUrineCreate(
    mockExecutor,
    {
      code: VOIDED_URINE_LOINC_CODE,
      effectiveDatetime: '2026-10-07T11:00:00.000Z',
      enteredMeasurementSystem: 'metric',
      urineColorCode: 'pale_yellow',
    },
    fixedNow,
  );
}

function allObservations(): Promise<Record<string, unknown>[]> {
  return mockExecutor.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM observations ORDER BY id',
  );
}

function allQueuedOperations(): Promise<Record<string, unknown>[]> {
  return mockExecutor.getAllAsync<Record<string, unknown>>(
    'SELECT * FROM sync_queue ORDER BY local_seq',
  );
}

async function press(label: string): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(label));
  });
}

let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-units-switch-'));
  mockExecutor = createNodeSqliteExecutor(join(dir, 'test.db'));
  await runMigrations(mockExecutor, fixedNow);
  await writeThresholds(
    mockExecutor,
    { softWarningMaxMl: 2000, maxClockSkewMs: 5 * 60 * 1000 },
    NOW_ISO,
  );
  await writeProfile(mockExecutor, PROFILE, NOW_ISO);
  await writeEntries();
});

afterEach(async () => {
  await mockExecutor.closeAsync();
  rmSync(dir, { recursive: true, force: true });
});

describe('switching measurement system', () => {
  it('re-renders stored volumes in the new units', async () => {
    await act(async () => {
      render(
        <ProfileProvider port={port}>
          <Settings />
          <StoredVolumes />
        </ProfileProvider>,
      );
    });
    expect(await screen.findByText(/Stoma output: 350 mL, Measured/)).toBeTruthy();

    await press(en.common['measurementSystem.imperial']);
    await press(en.common['settings.saveButton']);

    // ADR-0005: converted for display, and rounded to a whole unit only there.
    expect(await screen.findByText(/Stoma output: 12 fl oz, Measured/)).toBeTruthy();
    expect(screen.queryByText(/350 mL/)).toBeNull();
  });

  it('rewrites no stored entry, and queues nothing but the profile update', async () => {
    const entriesBefore = await allObservations();
    const queueBefore = await allQueuedOperations();
    expect(entriesBefore).toHaveLength(4);

    await act(async () => {
      render(
        <ProfileProvider port={port}>
          <Settings />
        </ProfileProvider>,
      );
    });
    await press(en.common['measurementSystem.imperial']);
    await press(en.common['settings.saveButton']);

    // Every column of every row, so a column added later is held to this too.
    expect(await allObservations()).toEqual(entriesBefore);
    // ADR-0012 by name: each row keeps the system it was typed in.
    expect((await allObservations()).map((row) => row.entered_measurement_system)).toEqual(
      entriesBefore.map((row) => row.entered_measurement_system),
    );

    const queueAfter = await allQueuedOperations();
    expect(queueAfter.slice(0, queueBefore.length)).toEqual(queueBefore);
    const added = queueAfter.slice(queueBefore.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      entity_type: 'Profile',
      entity_id: PROFILE.serverId,
      operation_type: 'update',
    });
  });

  it('rewrites nothing on the way back, either', async () => {
    const entriesBefore = await allObservations();
    await writeProfile(mockExecutor, { ...PROFILE, measurementSystem: 'imperial' }, NOW_ISO);

    await act(async () => {
      render(
        <ProfileProvider port={port}>
          <Settings />
        </ProfileProvider>,
      );
    });
    await press(en.common['measurementSystem.metric']);
    await press(en.common['settings.saveButton']);

    expect(await allObservations()).toEqual(entriesBefore);
  });
});
