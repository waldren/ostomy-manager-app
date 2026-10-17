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
 * The target ranges screen and its correction-inbox entry, through the real
 * screens and a real local database (P4.S3 slice 4, #139, SRS §3.9 and §3.10,
 * AC 14.1).
 *
 * These assert what reaches the queue, because a screen that showed the new
 * value and queued nothing, or queued a change the server must refuse, would
 * pass every rendering test.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../i18n/i18n';

import { en } from '@ostomy/core/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import Corrections from '../../app/corrections';
import TargetRanges from '../../app/target-ranges';
import type { SqliteExecutor } from '../db/executor';
import { runMigrations } from '../db/migrations';
import { enqueueRangeCreate } from '../db/offlineWrites';
import { writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import {
  getRangeWrite,
  writeRangeCache,
  type CachedRange,
} from '../db/repositories/rangesRepository';
import { listQueuedOperations, markRejected } from '../db/repositories/syncQueueRepository';
import { writeThresholds } from '../db/repositories/thresholdsRepository';
import { ProfileProvider } from '../onboarding/ProfileProvider';
import type { ProfilePort } from '../onboarding/provisionProfile';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

jest.setTimeout(30_000);

const NOW_ISO = '2026-10-17T12:00:00.000Z';
const CACHED_AT = '2026-10-17T11:00:00.000Z';
const OWN_ID = '11111111-1111-4111-8111-111111111111';
const PROPOSAL_ID = '22222222-2222-4222-8222-222222222222';

const PROFILE: LocalProfile = {
  ostomyType: 'ileostomy',
  surgeryDate: '2026-10-07',
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

const port: ProfilePort = {
  provision: () => Promise.resolve(PROFILE),
  read: () => Promise.resolve(PROFILE),
};

function range(overrides: Partial<CachedRange> = {}): CachedRange {
  return {
    rangeType: 'daily_output_ml',
    unit: 'mL',
    lowValue: 600,
    highValue: 1500,
    provenance: 'clinical_default',
    isActiveThreshold: false,
    divergesFromPhysician: false,
    basis: {
      ostomyType: 'ileostomy',
      daysPostOp: 10,
      minDaysPostOp: 0,
      maxDaysPostOp: 30,
      lowValue: 600,
      highValue: 1500,
    },
    patientRange: null,
    proposal: null,
    limits: { minValue: 0.0001, maxValue: 99999999.9999 },
    ...overrides,
  };
}

const OWN = {
  id: OWN_ID,
  lowValue: 700,
  highValue: 1400,
  targetValue: null,
  unit: 'mL',
  provenance: 'patient_set' as const,
};

async function renderScreen(
  ui: React.JSX.Element,
  options: { cached?: readonly CachedRange[]; profile?: LocalProfile } = {},
): Promise<void> {
  await writeProfile(mockExecutor, options.profile ?? PROFILE, NOW_ISO);
  if (options.cached !== undefined) {
    await writeRangeCache(mockExecutor, options.cached, CACHED_AT);
  }
  await act(async () => {
    render(<ProfileProvider port={port}>{ui}</ProfileProvider>);
  });
}

async function press(label: string): Promise<void> {
  await act(async () => {
    fireEvent.press(screen.getByLabelText(label));
  });
}

async function type(label: string, value: string): Promise<void> {
  await act(async () => {
    fireEvent.changeText(screen.getByLabelText(label), value);
  });
}

let dir: string;

beforeEach(async () => {
  mockReplace.mockReset();
  mockRequestSync.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-target-ranges-'));
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

describe('the target ranges screen', () => {
  /** There is no default this phone could honestly show before it has asked the server. */
  it('asks the patient to connect when it has never fetched the ranges', async () => {
    await renderScreen(<TargetRanges />);

    expect(screen.getByText(en.common['targetRanges.needsConnection'])).toBeTruthy();
  });

  it('shows the suggestion with its basis, and that it is only a suggestion', async () => {
    await renderScreen(<TargetRanges />, { cached: [range()] });

    expect(screen.getByText(en.common['rangeType.daily_output_ml'])).toBeTruthy();
    expect(screen.getByText(/600 mL to 1,500 mL/)).toBeTruthy();
    expect(screen.getByText(en.common['targetRanges.notConfirmed'])).toBeTruthy();
    expect(screen.getByText(/in the first weeks after surgery/)).toBeTruthy();
    // Nothing compares an entry against these yet (P5.S2).
    expect(screen.getByText(en.common['targetRanges.intro'])).toBeTruthy();
  });

  /** AC 14.1 AC2/AC3: a human action, and only that, turns the suggestion into a value in use. */
  it('accepts the typical range as the patient’s own, queued and shown at once', async () => {
    await renderScreen(<TargetRanges />, { cached: [range()] });

    await press(en.common['targetRanges.useTypicalButton']);

    const queued = await listQueuedOperations(mockExecutor);
    expect(queued).toEqual([
      expect.objectContaining({ entityType: 'EffectiveRange', operationType: 'create' }),
    ]);
    expect(await getRangeWrite(mockExecutor, queued[0]!.entityId)).toMatchObject({
      provenance: 'patient_confirmed_suggestion',
      lowValue: '600',
      highValue: '1500',
      status: 'active',
    });
    expect(screen.getByText(en.common['targetRanges.sourceConfirmed'])).toBeTruthy();
    expect(screen.getByText(en.common['targetRanges.waitingToSend'])).toBeTruthy();
    expect(mockRequestSync).toHaveBeenCalled();
  });

  /** ADR-0004: typed in the patient's own units, stored canonical, at the column's scale. */
  it('sets the patient’s own range from ounces, stored in millilitres', async () => {
    await renderScreen(<TargetRanges />, {
      cached: [range()],
      profile: { ...PROFILE, measurementSystem: 'imperial' },
    });

    await press(en.common['targetRanges.setOwnButton']);
    await type(en.common['targetRanges.formLowLabel'], '20');
    await press(en.common['targetRanges.formSaveButton']);

    const queued = await listQueuedOperations(mockExecutor);
    expect(await getRangeWrite(mockExecutor, queued[0]!.entityId)).toMatchObject({
      provenance: 'patient_set',
      lowValue: '591.4706',
      highValue: null,
    });
    expect(screen.getByText(en.common['targetRanges.sourcePatient'])).toBeTruthy();
  });

  it('refuses a value on the form, and queues nothing', async () => {
    await renderScreen(<TargetRanges />, { cached: [range()] });

    await press(en.common['targetRanges.setOwnButton']);
    await type(en.common['targetRanges.formLowLabel'], '900');
    await type(en.common['targetRanges.formHighLabel'], '600');
    await press(en.common['targetRanges.formSaveButton']);

    expect(screen.getByText(en.common['targetRanges.errorBelowLow'])).toBeTruthy();
    expect(await listQueuedOperations(mockExecutor)).toEqual([]);
  });

  it('withdraws the patient’s value, echoing what the server stored', async () => {
    await renderScreen(<TargetRanges />, {
      cached: [
        range({ provenance: 'patient_set', lowValue: 700, highValue: 1400, patientRange: OWN }),
      ],
    });

    await press(en.common['targetRanges.stopOwnButton']);

    expect(await listQueuedOperations(mockExecutor)).toEqual([
      expect.objectContaining({ entityId: OWN_ID, operationType: 'update' }),
    ]);
    expect(await getRangeWrite(mockExecutor, OWN_ID)).toMatchObject({
      status: 'superseded',
      lowValue: '700',
      highValue: '1400',
    });
    // Back to the suggestion, at once.
    expect(screen.getByText(en.common['targetRanges.notConfirmed'])).toBeTruthy();
  });

  it('takes back an unsent value instead of queuing a withdrawal of it', async () => {
    await renderScreen(<TargetRanges />, { cached: [range()] });
    await press(en.common['targetRanges.useTypicalButton']);

    await press(en.common['targetRanges.stopOwnButton']);

    expect(await listQueuedOperations(mockExecutor)).toEqual([]);
  });

  /**
   * AC 4: a physician's range is never changed from here and stays in use. A
   * patient may save their own beside it, and is told which one is in use.
   */
  it('keeps a physician’s range in use and does not offer to replace it with the typical one', async () => {
    await renderScreen(<TargetRanges />, {
      cached: [
        range({
          provenance: 'physician_set',
          lowValue: 450,
          highValue: 950,
          isActiveThreshold: true,
        }),
      ],
    });

    expect(screen.getByText(en.common['targetRanges.sourcePhysician'])).toBeTruthy();
    expect(screen.queryByLabelText(en.common['targetRanges.useTypicalButton'])).toBeNull();

    await press(en.common['targetRanges.setOwnButton']);
    expect(screen.getByText(en.common['targetRanges.physicianStaysNote'])).toBeTruthy();
    await type(en.common['targetRanges.formLowLabel'], '800');
    await press(en.common['targetRanges.formSaveButton']);

    expect(screen.getByText(/450 mL to 950 mL/)).toBeTruthy();
    expect(screen.getByText(en.common['targetRanges.divergesFromPhysician'])).toBeTruthy();
  });

  it.each([
    ['accepts', 'targetRanges.acceptProposalButton', 'active'],
    ['declines', 'targetRanges.dismissProposalButton', 'dismissed'],
  ] as const)('%s a range waiting for the patient', async (_verb, button, status) => {
    await renderScreen(<TargetRanges />, {
      cached: [
        range({
          proposal: { ...OWN, id: PROPOSAL_ID, provenance: 'patient_confirmed_suggestion' },
        }),
      ],
    });
    expect(screen.getByText(/A range is waiting for you to decide/)).toBeTruthy();

    await press(en.common[button]);

    expect(await getRangeWrite(mockExecutor, PROPOSAL_ID)).toMatchObject({ status });
    expect(screen.queryByText(/A range is waiting for you to decide/)).toBeNull();
  });
});

describe('a refused range change in the correction inbox', () => {
  it('is shown, and removed with its row when the patient removes it', async () => {
    await writeProfile(mockExecutor, PROFILE, NOW_ISO);
    const { id, operationId } = await enqueueRangeCreate(
      mockExecutor,
      {
        rangeType: 'daily_output_ml',
        lowValue: '800',
        highValue: null,
        unit: 'mL',
        provenance: 'patient_set',
      },
      () => new Date(NOW_ISO),
    );
    await markRejected(mockExecutor, operationId, {
      reasonCode: 'PAYLOAD_FIELD_INVALID',
      field: 'lowValue',
      rejectedAt: NOW_ISO,
    });

    await renderScreen(<Corrections />);
    expect(screen.getByText(en.common['corrections.rangeProblem'])).toBeTruthy();

    await press(en.common['corrections.rangeDiscardButton']);

    expect(await mockExecutor.getAllAsync('SELECT * FROM sync_queue;')).toEqual([]);
    expect(await getRangeWrite(mockExecutor, id)).toBeUndefined();
    expect(screen.queryByText(en.common['corrections.rangeProblem'])).toBeNull();
  });
});
