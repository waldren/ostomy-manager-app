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
 * Keeping and removing Quick-Add buttons, through the real screen and a real
 * local database (P4.S3 slice 5b, #139, SRS §3.10, Epic 15 story 3).
 *
 * These assert what reaches the database and the queue, because a screen that
 * moved a button and queued nothing would pass every rendering test and lose
 * the decision on the patient's other devices.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../i18n/i18n';

import { en } from '@ostomy/core/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import QuickAdd from '../../app/quick-add';
import type { SqliteExecutor } from '../db/executor';
import { runMigrations } from '../db/migrations';
import { enqueueQuickAddDecision, enqueueVolumetricObservationCreate } from '../db/offlineWrites';
import { writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import { listQuickAddDecisions } from '../db/repositories/quickAddDecisionsRepository';
import { listQueuedOperations } from '../db/repositories/syncQueueRepository';
import { STOMA_OUTPUT_LOINC_CODE } from '../entry/observationCodes';
import { ProfileProvider } from '../onboarding/ProfileProvider';
import type { ProfilePort } from '../onboarding/provisionProfile';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

jest.setTimeout(30_000);

const NOW_ISO = '2026-10-17T12:00:00.000Z';

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
    router: { replace: jest.fn(), push: jest.fn(), back: jest.fn(), canGoBack: () => true },
    useLocalSearchParams: () => ({}),
    Redirect: ({ href }: { href: string }) => <RNText>{`redirect:${href}`}</RNText>,
  };
});

const mockRequestSync = jest.fn();
jest.mock('../sync/SyncProvider', () => ({
  useSyncStatus: () => ({
    requestSync: mockRequestSync,
    isRunning: false,
    lastRejected: 0,
    lastStop: undefined,
  }),
}));

jest.mock('../lib/utils/clock', () => ({
  now: () => new Date('2026-10-17T12:00:00.000Z'),
  deviceTimeZone: () => 'UTC',
  toWireInstant: (date: Date) => date.toISOString(),
}));

function port(profile: LocalProfile): ProfilePort {
  return { provision: () => Promise.resolve(profile), read: () => Promise.resolve(profile) };
}

/** Logs a measured stoma output `times` times in the last few days. */
async function logOutput(value: string, times: number): Promise<void> {
  for (let day = 1; day <= times; day += 1) {
    await enqueueVolumetricObservationCreate(
      mockExecutor,
      {
        code: STOMA_OUTPUT_LOINC_CODE,
        valueQuantityValue: value,
        valueQuantityUnit: 'mL',
        effectiveDatetime: new Date(Date.parse(NOW_ISO) - day * 86_400_000).toISOString(),
        measuredOrEstimated: 'measured',
        enteredMeasurementSystem: 'metric',
        fluidTypeCode: null,
      },
      () => new Date(NOW_ISO),
    );
  }
  // The entries' own operations are not what these tests are about.
  await mockExecutor.runAsync('DELETE FROM sync_queue;');
}

async function renderScreen(profile: LocalProfile = PROFILE): Promise<void> {
  await writeProfile(mockExecutor, profile, NOW_ISO);
  await act(async () => {
    render(
      <ProfileProvider port={port(profile)}>
        <QuickAdd />
      </ProfileProvider>,
    );
  });
}

async function press(label: RegExp | string): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(label));
  });
}

let dir: string;
let announce: jest.SpyInstance;

beforeEach(async () => {
  mockRequestSync.mockReset();
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-quick-add-screen-'));
  mockExecutor = createNodeSqliteExecutor(join(dir, 'test.db'));
  await runMigrations(mockExecutor, () => new Date(NOW_ISO));
});

afterEach(async () => {
  announce.mockRestore();
  await mockExecutor.closeAsync();
  rmSync(dir, { recursive: true, force: true });
});

describe('the Quick-Add buttons screen', () => {
  it('says how a button appears when there are none yet', async () => {
    await renderScreen();

    expect(screen.getByText(en.common['quickAdd.manageEmpty'])).toBeTruthy();
  });

  it('keeps a button: saved, queued, announced, and shown as kept', async () => {
    await logOutput('350', 2);
    await renderScreen();

    await press(/^Keep this button: 350 mL/);

    expect(await listQuickAddDecisions(mockExecutor)).toEqual([
      expect.objectContaining({
        decision: 'pinned',
        routine: expect.objectContaining({ valueMl: 350 }),
      }),
    ]);
    expect(await listQueuedOperations(mockExecutor)).toEqual([
      expect.objectContaining({ entityType: 'QuickAddPreference', operationType: 'create' }),
    ]);
    expect(announce).toHaveBeenCalledWith(en.common['quickAdd.announceKept']);
    expect(mockRequestSync).toHaveBeenCalled();
    expect(screen.getByText(/You chose to keep this one\./)).toBeTruthy();
    expect(screen.getByLabelText(/^Stop keeping this button: 350 mL/)).toBeTruthy();
  });

  /** Epic 15 story 3, and the way back: removing is never final. */
  it('removes a button to the removed list, and brings it back from there', async () => {
    await logOutput('350', 3);
    await renderScreen();

    await press(/^Remove this button: 350 mL/);

    expect(screen.getByText(en.common['quickAdd.removedHeading'])).toBeTruthy();
    expect(screen.queryByLabelText(/^Keep this button: 350 mL/)).toBeNull();
    expect(announce).toHaveBeenCalledWith(en.common['quickAdd.announceRemoved']);

    await press(/^Bring this button back: 350 mL/);

    expect((await listQuickAddDecisions(mockExecutor))[0]).toMatchObject({ decision: 'none' });
    expect(screen.getByLabelText(/^Keep this button: 350 mL/)).toBeTruthy();
    expect(screen.queryByText(en.common['quickAdd.removedHeading'])).toBeNull();
  });

  /**
   * Keeping is what pinning means: a kept button stays after the routine stops.
   * It says it was kept, and nothing about a count — "You logged this 0 times
   * recently" would read as a fault.
   */
  it('keeps a kept button whose routine has stopped, saying only that it was kept', async () => {
    await enqueueQuickAddDecision(
      mockExecutor,
      {
        profileServerId: PROFILE.serverId as string,
        routine: {
          code: STOMA_OUTPUT_LOINC_CODE,
          valueMl: 350,
          method: '258104002',
          fluidTypeCode: null,
          urineColorCode: null,
          enteredMeasurementSystem: 'metric',
        },
        decision: 'pinned',
      },
      () => new Date(NOW_ISO),
    );
    await renderScreen();

    expect(screen.getByText(en.common['quickAdd.kept'])).toBeTruthy();
    expect(screen.queryByText(/times recently/)).toBeNull();
    expect(screen.getByLabelText(/^Stop keeping this button: 350 mL/)).toBeTruthy();
  });

  /** A phone set up before P4.S3 has nothing to name the row with until it has been online once. */
  it('asks for a connection, and changes nothing, before the profile id is known', async () => {
    await logOutput('350', 2);
    const { serverId: _serverId, ...legacy } = PROFILE;
    await renderScreen(legacy as LocalProfile);

    expect(screen.getByText(en.common['settings.needsConnectionBody'])).toBeTruthy();
    await press(/^Keep this button: 350 mL/);

    expect(await listQuickAddDecisions(mockExecutor)).toEqual([]);
  });
});
