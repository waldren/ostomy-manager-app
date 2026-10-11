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
 * The correction editor's amount field, for an imperial patient.
 *
 * `app/corrections.tsx` had no spec of any kind, which is why this survived:
 * the editor prefilled the stored CANONICAL millilitre value into a field the
 * save path reads as the patient's own unit. A rejected 12 fl oz entry is
 * stored as 354.8824 mL, reopened as "354.8824 fl oz", and confirming the
 * correction wrote 10,494 mL — the entry multiplied by the conversion factor,
 * on a screen whose entire purpose is to fix a value. It trips the >2,000 mL
 * Tier 2 warning, which is overridable by design, so nothing blocked it.
 *
 * The same class as the container-size defect beside it, and invisible under
 * metric for the same reason: canonical mL and displayed mL are the same
 * number, so the round trip is lossless and the bug has no symptom.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../i18n/i18n';

import { act, fireEvent, render, screen } from '@testing-library/react-native';

import Corrections from '../../app/corrections';
import { runMigrations } from '../db/migrations';
import { enqueueVolumetricObservationCreate } from '../db/offlineWrites';
import { writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import { markRejected } from '../db/repositories/syncQueueRepository';
import { writeThresholds } from '../db/repositories/thresholdsRepository';
import type { SqliteExecutor } from '../db/executor';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { ProfileProvider } from './ProfileProvider';
import type { ProfilePort } from './provisionProfile';

jest.setTimeout(30_000);

const AT = '2026-10-08T12:00:00.000Z';

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

/** 12 fl oz, as the entry screen would have stored it: canonical mL, 4 dp. */
const TWELVE_FL_OZ_IN_ML = '354.8824';

async function seedRejectedEntry(): Promise<void> {
  const { operationId } = await enqueueVolumetricObservationCreate(
    mockExecutor,
    {
      code: '79560-9',
      valueQuantityValue: TWELVE_FL_OZ_IN_ML,
      valueQuantityUnit: 'mL',
      effectiveDatetime: AT,
      measuredOrEstimated: 'measured',
      enteredMeasurementSystem: 'imperial',
    },
    () => new Date(AT),
  );
  await markRejected(mockExecutor, operationId, {
    reasonCode: 'effective_date_time_in_future',
    field: 'effectiveDateTime',
    rejectedAt: AT,
  });
}

async function renderScreen(profile: LocalProfile): Promise<void> {
  await writeProfile(mockExecutor, profile, AT);
  await act(async () => {
    render(
      <ProfileProvider port={port}>
        <Corrections />
      </ProfileProvider>,
    );
  });
}

describe('the correction editor amount field', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-corrections-'));
    mockExecutor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(mockExecutor, () => new Date(AT));
    await writeThresholds(
      mockExecutor,
      { softWarningMaxMl: 2000, maxClockSkewMs: 5 * 60 * 1000 },
      AT,
    );
    await seedRejectedEntry();
  });

  afterEach(async () => {
    await mockExecutor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  async function openEditor(): Promise<void> {
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Fix this entry'));
    });
  }

  /**
   * The defect, stated as the value the patient sees. 354.8824 in a field
   * labelled "fl oz" is the stored canonical number wearing the wrong unit.
   */
  it('opens an imperial entry at the amount the patient typed, not the stored one', async () => {
    await renderScreen(IMPERIAL);
    await openEditor();

    const field = screen.getByLabelText('How much came out?');
    expect(field.props.value).toBe('12');
    expect(field.props.value).not.toBe(TWELVE_FL_OZ_IN_ML);
  });

  /** Metric is the case that hid it: the conversion is the identity. */
  it('opens a metric entry at the stored value unchanged', async () => {
    await renderScreen(METRIC);
    await openEditor();

    expect(screen.getByLabelText('How much came out?').props.value).toBe(TWELVE_FL_OZ_IN_ML);
  });
});
