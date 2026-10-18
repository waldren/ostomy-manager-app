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
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import Corrections from '../../app/corrections';
import QuickAdd from '../../app/quick-add';
import type { SqliteExecutor } from '../db/executor';
import { runMigrations } from '../db/migrations';
import { enqueueQuickAddDecision, enqueueVolumetricObservationCreate } from '../db/offlineWrites';
import { writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import { listQuickAddDecisions } from '../db/repositories/quickAddDecisionsRepository';
import { listQueuedOperations, markRejected } from '../db/repositories/syncQueueRepository';
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

function port(profile: LocalProfile, read?: ProfilePort['read']): ProfilePort {
  return {
    provision: () => Promise.resolve(profile),
    read: read ?? (() => Promise.resolve(profile)),
  };
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

async function renderScreen(
  profile: LocalProfile = PROFILE,
  options: { read?: ProfilePort['read']; screen?: React.JSX.Element } = {},
): Promise<void> {
  await writeProfile(mockExecutor, profile, NOW_ISO);
  await act(async () => {
    render(
      <ProfileProvider port={port(profile, options.read)}>
        {options.screen ?? <QuickAdd />}
      </ProfileProvider>,
    );
  });
}

const OUTPUT_350 = {
  code: STOMA_OUTPUT_LOINC_CODE,
  valueMl: 350,
  method: '258104002',
  fluidTypeCode: null,
  urineColorCode: null,
  enteredMeasurementSystem: 'metric' as const,
};

/** A decision already saved, as a decision made earlier or on another device would be. */
async function decided(
  decision: 'pinned' | 'hidden',
): Promise<{ id: string; operationId: string }> {
  const written = await enqueueQuickAddDecision(
    mockExecutor,
    { profileServerId: PROFILE.serverId as string, routine: OUTPUT_350, decision },
    () => new Date(NOW_ISO),
  );
  return written;
}

const SPOKEN_350 = 'Stoma output: 350 milliliters, Measured';

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

    await press(/^Keep this button: Stoma output: 350 milliliters, Measured/);

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
    expect(screen.getByText(/You chose to keep it\./)).toBeTruthy();
    expect(
      screen.getByLabelText(/^Stop keeping this button: Stoma output: 350 milliliters, Measured/),
    ).toBeTruthy();
  });

  /** Epic 15 story 3, and the way back: removing is never final. */
  it('removes a button to the removed list, and brings it back from there', async () => {
    await logOutput('350', 3);
    await renderScreen();

    await press(/^Remove this button: Stoma output: 350 milliliters, Measured/);

    expect(screen.getByText(en.common['quickAdd.removedHeading'])).toBeTruthy();
    expect(
      screen.queryByLabelText(/^Keep this button: Stoma output: 350 milliliters, Measured/),
    ).toBeNull();
    expect(announce).toHaveBeenCalledWith(en.common['quickAdd.announceRemoved']);

    await press(/^Bring this button back: Stoma output: 350 milliliters, Measured/);

    expect((await listQuickAddDecisions(mockExecutor))[0]).toMatchObject({ decision: 'none' });
    expect(
      screen.getByLabelText(/^Keep this button: Stoma output: 350 milliliters, Measured/),
    ).toBeTruthy();
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
    expect(
      screen.getByLabelText(/^Stop keeping this button: Stoma output: 350 milliliters, Measured/),
    ).toBeTruthy();
  });

  /** A phone set up before P4.S3 has nothing to name the row with until it has been online once. */
  it('asks for a connection, and changes nothing, before the profile id is known', async () => {
    await logOutput('350', 2);
    const { serverId: _serverId, ...legacy } = PROFILE;
    await renderScreen(legacy as LocalProfile);

    expect(screen.getByText(en.common['quickAdd.needsConnectionBody'])).toBeTruthy();
    await press(/^Keep this button: Stoma output: 350 milliliters, Measured/);

    expect(await listQuickAddDecisions(mockExecutor)).toEqual([]);
  });

  /**
   * #149 review: "Stop keeping" on a button whose routine has stopped made it
   * vanish from both lists, with nothing on screen to undo it. It stays listed,
   * saying it has left the home screen, with Keep still beside it.
   */
  it('keeps a just-unkept button listed when it has left the home screen, and says so', async () => {
    await decided('pinned');
    await renderScreen();

    await press(`Stop keeping this button: ${SPOKEN_350}`);

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith(en.common['quickAdd.announceUnkeptGone']);
    });
    expect(screen.getByText(en.common['quickAdd.leftHome'])).toBeTruthy();
    expect(screen.getByLabelText(`Keep this button: ${SPOKEN_350}`)).toBeTruthy();
  });

  it('says a button is back when bringing it back puts it on the home screen', async () => {
    await logOutput('350', 2);
    await decided('hidden');
    await renderScreen();
    expect(screen.getByText(en.common['quickAdd.manageEmptyAllRemoved'])).toBeTruthy();

    await press(`Bring this button back: ${SPOKEN_350}`);

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith(en.common['quickAdd.announceRestoredShown']);
    });
  });

  it('says when a brought-back button will return, and keeps it listed until then', async () => {
    await decided('hidden');
    await renderScreen();

    await press(`Bring this button back: ${SPOKEN_350}`);

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith(en.common['quickAdd.announceRestoredLater']);
    });
    expect(screen.getByLabelText(`Remove this button: ${SPOKEN_350}`)).toBeTruthy();
  });

  /** Otherwise "Try again" changes nothing on screen when it fails, and says nothing. */
  it('says so when trying to connect again still fails', async () => {
    const { serverId: _serverId, ...legacy } = PROFILE;
    await renderScreen(legacy as LocalProfile, {
      read: () => Promise.reject(new TypeError('Network request failed')),
    });

    await press(en.common['settings.retryButton']);

    await waitFor(() => {
      expect(announce).toHaveBeenCalledWith(en.common['quickAdd.stillNoConnection']);
    });
  });
});

describe('a refused Quick-Add decision in the correction inbox', () => {
  /** §3.8: reachable on a phone whose clock has drifted, and fixed by sending again. */
  it('names the button and sends a clock-refused decision again', async () => {
    const { operationId } = await decided('pinned');
    await markRejected(mockExecutor, operationId, {
      reasonCode: 'CLIENT_TIMESTAMP_OUT_OF_RANGE',
      field: 'clientTimestamp',
      rejectedAt: NOW_ISO,
    });
    await renderScreen(PROFILE, { screen: <Corrections /> });

    expect(
      screen.getByText(/^Your change to the button "Stoma output: 350 mL, Measured"/),
    ).toBeTruthy();
    await press(`Try again: the button ${SPOKEN_350}`);

    const queued = await listQueuedOperations(mockExecutor);
    expect(queued).toEqual([expect.objectContaining({ entityType: 'QuickAddPreference' })]);
    expect(queued[0]?.operationId).not.toBe(operationId);
  });

  it('offers only to clear a decision refused for any other reason', async () => {
    const { operationId } = await decided('hidden');
    await markRejected(mockExecutor, operationId, {
      reasonCode: 'PAYLOAD_FIELD_INVALID',
      field: 'id',
      rejectedAt: NOW_ISO,
    });
    await renderScreen(PROFILE, { screen: <Corrections /> });

    expect(screen.queryByText(en.common['corrections.quickAddRetryButton'])).toBeNull();
    await press(`Clear this change to the button ${SPOKEN_350}`);

    expect(await mockExecutor.getAllAsync('SELECT * FROM sync_queue;')).toEqual([]);
    expect(await listQuickAddDecisions(mockExecutor)).toEqual([]);
  });
});
