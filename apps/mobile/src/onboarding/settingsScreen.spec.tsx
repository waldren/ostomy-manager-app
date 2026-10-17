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
 * Editing the profile, through the real Settings and correction-inbox screens
 * and a real local database (P4.S3 slice 2, #139, SRS §3.10).
 *
 * These assert what reaches the database and the queue, because that is where
 * an edit can go wrong without showing it: a screen that displayed the new
 * units and queued nothing, or queued an edit the server could not apply,
 * would pass every rendering test.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../i18n/i18n';

import { en } from '@ostomy/core/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import Corrections from '../../app/corrections';
import Settings from '../../app/settings';
import type { SqliteExecutor } from '../db/executor';
import { runMigrations } from '../db/migrations';
import { enqueueProfileUpdate } from '../db/offlineWrites';
import { readProfile, writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import {
  listQueuedOperations,
  listRejectedOperations,
  markRejected,
} from '../db/repositories/syncQueueRepository';
import { writeThresholds } from '../db/repositories/thresholdsRepository';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { ProfileProvider, useProfile } from './ProfileProvider';
import type { ProfilePort } from './provisionProfile';

jest.setTimeout(30_000);

const NOW_ISO = '2026-10-08T12:00:00.000Z';
const SERVER_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

const PROFILE: LocalProfile = {
  ostomyType: 'ileostomy',
  surgeryDate: '2026-09-01',
  measurementSystem: 'metric',
  serverId: SERVER_ID,
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

const mockReplace = jest.fn();
jest.mock('expo-router', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return {
    router: { replace: (href: string) => mockReplace(href), push: jest.fn(), back: jest.fn() },
    useLocalSearchParams: () => ({}),
    Redirect: ({ href }: { href: string }) => <RNText>{`redirect:${href}`}</RNText>,
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

/** What any other screen sees: the profile `withProfile` would hand it. */
function ProfileProbe(): React.JSX.Element {
  const profile = useProfile();
  return <Text>{`units:${profile?.measurementSystem ?? 'none'}`}</Text>;
}

function port(read: ProfilePort['read'] = () => Promise.resolve(PROFILE)): ProfilePort {
  return { provision: () => Promise.resolve(PROFILE), read };
}

async function renderWithProfile(
  ui: React.JSX.Element,
  options: { profile?: LocalProfile; port?: ProfilePort } = {},
): Promise<void> {
  await writeProfile(mockExecutor, options.profile ?? PROFILE, NOW_ISO);
  await act(async () => {
    render(
      <ProfileProvider port={options.port ?? port()}>
        {ui}
        <ProfileProbe />
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

let dir: string;

beforeEach(async () => {
  mockReplace.mockReset();
  mockRequestSync.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-settings-'));
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

describe('Settings', () => {
  it('opens with the patient’s current answers', async () => {
    await renderWithProfile(<Settings />);

    expect(screen.getByLabelText(en.common['onboarding.surgeryDateDayLabel']).props.value).toBe(
      '01',
    );
    expect(screen.getByLabelText(en.common['onboarding.surgeryDateYearLabel']).props.value).toBe(
      '2026',
    );
  });

  /**
   * SRS §3.10 and Epic 15: switch units and see everything in them. The edit
   * is offline-first — saved here and queued — and every screen reading the
   * profile moves with it.
   */
  it('saves a change of units on this phone, queues it, and every screen follows', async () => {
    await renderWithProfile(<Settings />);

    await press(en.common['measurementSystem.imperial']);
    await press(en.common['settings.saveButton']);

    expect((await readProfile(mockExecutor))?.measurementSystem).toBe('imperial');
    const queued = await listQueuedOperations(mockExecutor);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      entityType: 'Profile',
      entityId: SERVER_ID,
      operationType: 'update',
    });
    expect(screen.getByText('units:imperial')).toBeTruthy();
    expect(screen.getByText(en.common['settings.saved'])).toBeTruthy();
    expect(mockRequestSync).toHaveBeenCalled();
  });

  it('saves a new surgery date', async () => {
    await renderWithProfile(<Settings />);

    await type(en.common['onboarding.surgeryDateDayLabel'], '25');
    await type(en.common['onboarding.surgeryDateMonthLabel'], '8');
    await press(en.common['settings.saveButton']);

    expect((await readProfile(mockExecutor))?.surgeryDate).toBe('2026-08-25');
  });

  it.each([
    ['a date that has not happened yet', '9', '10', 'onboarding.surgeryDateInTheFuture'],
    ['a date that does not exist', '31', '2', 'onboarding.surgeryDateNotADate'],
  ] as const)(
    'refuses %s with onboarding’s message, and queues nothing',
    async (_label, day, month, messageKey) => {
      await renderWithProfile(<Settings />);

      await type(en.common['onboarding.surgeryDateDayLabel'], day);
      await type(en.common['onboarding.surgeryDateMonthLabel'], month);
      await press(en.common['settings.saveButton']);

      expect(screen.getByText(en.common[messageKey])).toBeTruthy();
      expect(await listQueuedOperations(mockExecutor)).toEqual([]);
      expect(await readProfile(mockExecutor)).toEqual(PROFILE);
    },
  );

  it('queues nothing when nothing changed', async () => {
    // A no-op edit would still move the profile's last-write-wins timestamp and
    // could overwrite a real change made on another device a moment earlier.
    await renderWithProfile(<Settings />);

    await press(en.common['settings.saveButton']);

    expect(screen.getByText(en.common['settings.nothingChanged'])).toBeTruthy();
    expect(await listQueuedOperations(mockExecutor)).toEqual([]);
  });

  it('says a connection is needed first on a phone that has never learned its profile id', async () => {
    // Set up before P4.S3 and offline since: an edit would have nowhere to go.
    const { serverId: _omitted, ...legacy } = PROFILE;
    await renderWithProfile(<Settings />, {
      profile: legacy,
      port: port(() => Promise.reject(new Error('offline'))),
    });

    expect(screen.getByText(en.common['settings.needsConnectionBody'])).toBeTruthy();
    await press(en.common['measurementSystem.imperial']);
    await press(en.common['settings.saveButton']);
    expect(await listQueuedOperations(mockExecutor)).toEqual([]);
  });
});

describe('a profile edit the server refused, in the correction inbox', () => {
  async function rejectedEdit(): Promise<string> {
    await writeProfile(mockExecutor, PROFILE, NOW_ISO);
    const { operationId } = await enqueueProfileUpdate(
      mockExecutor,
      SERVER_ID,
      { ostomyType: 'ileostomy', surgeryDate: '1925-01-01', measurementSystem: 'metric' },
      () => new Date(NOW_ISO),
    );
    await markRejected(mockExecutor, operationId, {
      reasonCode: 'PAYLOAD_FIELD_INVALID',
      field: 'surgeryDate',
      rejectedAt: NOW_ISO,
    });
    return operationId;
  }

  /**
   * The home screen counts every rejected operation and links here, so a
   * profile rejection this screen did not render would be a count pointing at
   * an empty page.
   */
  it('is shown, naming the surgery date', async () => {
    await rejectedEdit();
    await renderWithProfile(<Corrections />, {
      profile: { ...PROFILE, surgeryDate: '1925-01-01' },
    });

    expect(screen.getByText(en.common['corrections.profileSurgeryDateProblem'])).toBeTruthy();
    expect(screen.queryByText(en.common['corrections.empty'])).toBeNull();
  });

  it('can be undone, which puts the server’s answers back and clears it', async () => {
    await rejectedEdit();
    await renderWithProfile(<Corrections />, {
      profile: { ...PROFILE, surgeryDate: '1925-01-01' },
    });

    await press(en.common['corrections.profileUndoButton']);

    expect(await readProfile(mockExecutor)).toEqual(PROFILE);
    expect(await listRejectedOperations(mockExecutor)).toEqual([]);
    expect(screen.getByText(en.common['corrections.empty'])).toBeTruthy();
  });

  it('is kept when the server cannot be reached to undo it', async () => {
    // Nothing is removed without something true to replace it with.
    await rejectedEdit();
    await renderWithProfile(<Corrections />, {
      profile: { ...PROFILE, surgeryDate: '1925-01-01' },
      port: port(() => Promise.reject(new Error('offline'))),
    });

    await press(en.common['corrections.profileUndoButton']);

    expect(screen.getByText(en.common['corrections.profileUndoUnreachable'])).toBeTruthy();
    expect(await listRejectedOperations(mockExecutor)).toHaveLength(1);
  });
});
