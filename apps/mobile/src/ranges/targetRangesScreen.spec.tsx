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
 * pass every rendering test. Buttons are found by their SPOKEN names, which
 * name the measure: that is the name a screen-reader or voice-control user has.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import '../i18n/i18n';

import { en } from '@ostomy/core/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';

import Corrections from '../../app/corrections';
import TargetRanges from '../../app/target-ranges';
import type { SqliteExecutor } from '../db/executor';
import { runMigrations } from '../db/migrations';
import { enqueueRangeCreate } from '../db/offlineWrites';
import { writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import {
  listOverlayRangeWrites,
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
const MEASURE = en.common['rangeType.daily_output_ml'];

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
const mockBack = jest.fn();
jest.mock('expo-router', () => {
  const { Text: RNText } = jest.requireActual('react-native');
  return {
    router: {
      replace: (href: string) => mockReplace(href),
      push: jest.fn(),
      back: () => mockBack(),
      canGoBack: () => true,
    },
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

/** A catalog string with its `{{placeholders}}` filled, as i18next renders it. */
function copy(key: keyof typeof en.common, values: Record<string, string> = {}): string {
  return Object.entries({ measure: MEASURE, ...values }).reduce(
    (text, [name, value]) => text.replaceAll(`{{${name}}}`, value),
    en.common[key] as string,
  );
}

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

/** The changes this phone has saved for ranges, in order, with the status each one sets. */
async function savedChanges() {
  return (await listOverlayRangeWrites(mockExecutor)).map((write) => ({
    id: write.id,
    status: write.status,
    provenance: write.provenance,
    lowValue: write.lowValue,
    highValue: write.highValue,
  }));
}

let dir: string;
let announce: jest.SpyInstance;

beforeEach(async () => {
  mockReplace.mockReset();
  mockBack.mockReset();
  mockRequestSync.mockReset();
  announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
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
  announce.mockRestore();
  await mockExecutor.closeAsync();
  rmSync(dir, { recursive: true, force: true });
});

describe('the target ranges screen', () => {
  /** There is no default this phone could honestly show before it has asked the server. */
  it('asks the patient to connect when it has never fetched the ranges, and offers to try now', async () => {
    await renderScreen(<TargetRanges />);

    expect(screen.getByText(en.common['targetRanges.needsConnection'])).toBeTruthy();
    await press(en.common['settings.retryButton']);
    expect(mockRequestSync).toHaveBeenCalled();
  });

  it('shows the suggestion with its basis, and that it is only a suggestion', async () => {
    await renderScreen(<TargetRanges />, { cached: [range()] });

    expect(screen.getByText(MEASURE)).toBeTruthy();
    expect(screen.getByText(/600 mL to 1,500 mL/)).toBeTruthy();
    expect(screen.getByText(en.common['targetRanges.notConfirmed'])).toBeTruthy();
    expect(screen.getByText(/in the first weeks after surgery/)).toBeTruthy();
    // Nothing compares an entry against these yet (P5.S2).
    expect(screen.getByText(en.common['targetRanges.intro'])).toBeTruthy();
  });

  /** "fl oz" is read letter by letter, so the spoken value spells the unit out. */
  it('speaks the value with its unit spelled out', async () => {
    await renderScreen(<TargetRanges />, {
      cached: [range()],
      profile: { ...PROFILE, measurementSystem: 'imperial' },
    });

    expect(screen.getByLabelText(/fluid ounces to .* fluid ounces/)).toBeTruthy();
  });

  /** AC 14.1 AC2/AC3: a human action, and only that, turns the suggestion into a value in use. */
  it('accepts the typical range as the patient’s own, queued, shown and announced at once', async () => {
    await renderScreen(<TargetRanges />, { cached: [range()] });

    await press(copy('targetRanges.useTypicalSpoken'));

    expect(await listQueuedOperations(mockExecutor)).toEqual([
      expect.objectContaining({ entityType: 'EffectiveRange', operationType: 'create' }),
    ]);
    expect(await savedChanges()).toEqual([
      expect.objectContaining({
        provenance: 'patient_confirmed_suggestion',
        lowValue: '600',
        highValue: '1500',
        status: 'active',
      }),
    ]);
    expect(screen.getByText(en.common['targetRanges.sourceConfirmed'])).toBeTruthy();
    expect(screen.getByText(en.common['targetRanges.waitingToSend'])).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(copy('targetRanges.announceTypical'));
    expect(mockRequestSync).toHaveBeenCalled();
  });

  /** ADR-0004: typed in the patient's own units, stored canonical, at the column's scale. */
  it('sets the patient’s own range from ounces, stored in millilitres', async () => {
    await renderScreen(<TargetRanges />, {
      cached: [range()],
      profile: { ...PROFILE, measurementSystem: 'imperial' },
    });

    await press(copy('targetRanges.setOwnSpoken'));
    await type(copy('targetRanges.formLowSpoken', { unit: 'fluid ounces' }), '20');
    await press(copy('targetRanges.formSaveSpoken'));

    expect(await savedChanges()).toEqual([
      expect.objectContaining({ provenance: 'patient_set', lowValue: '591.4706', highValue: null }),
    ]);
    expect(screen.getByText(en.common['targetRanges.sourcePatient'])).toBeTruthy();
  });

  it('refuses a value on the form, and queues nothing', async () => {
    await renderScreen(<TargetRanges />, { cached: [range()] });

    await press(copy('targetRanges.setOwnSpoken'));
    await type(copy('targetRanges.formLowSpoken', { unit: 'milliliters' }), '900');
    await type(copy('targetRanges.formHighSpoken', { unit: 'milliliters' }), '600');
    await press(copy('targetRanges.formSaveSpoken'));

    expect(screen.getByText(en.common['targetRanges.errorBelowLow'])).toBeTruthy();
    expect(await listQueuedOperations(mockExecutor)).toEqual([]);
  });

  /** WCAG 3.3.3: the error says what the app CAN store. */
  it('says what number would work when one is too big to store', async () => {
    await renderScreen(<TargetRanges />, {
      cached: [range({ limits: { minValue: 0.0001, maxValue: 5000 } })],
    });

    await press(copy('targetRanges.setOwnSpoken'));
    await type(copy('targetRanges.formHighSpoken', { unit: 'milliliters' }), '6000');
    await press(copy('targetRanges.formSaveSpoken'));

    expect(screen.getByText(copy('targetRanges.errorTooBig', { max: '5,000 mL' }))).toBeTruthy();
  });

  it('opens the form with the patient’s own range already in it', async () => {
    await renderScreen(<TargetRanges />, {
      cached: [
        range({ provenance: 'patient_set', lowValue: 700, highValue: 1400, patientRange: OWN }),
      ],
    });

    await press(copy('targetRanges.changeOwnSpoken'));

    expect(
      screen.getByLabelText(copy('targetRanges.formLowSpoken', { unit: 'milliliters' })).props
        .value,
    ).toBe('700');
  });

  it('asks before withdrawing the patient’s value, then echoes what the server stored', async () => {
    await renderScreen(<TargetRanges />, {
      cached: [
        range({ provenance: 'patient_set', lowValue: 700, highValue: 1400, patientRange: OWN }),
      ],
    });

    await press(copy('targetRanges.stopOwnSpoken'));
    expect(screen.getByText(copy('targetRanges.stopConfirmTypical'))).toBeTruthy();
    expect(await listQueuedOperations(mockExecutor)).toEqual([]);

    await press(copy('targetRanges.stopConfirmSpoken'));

    expect(await listQueuedOperations(mockExecutor)).toEqual([
      expect.objectContaining({ entityId: OWN_ID, operationType: 'update' }),
    ]);
    expect(await savedChanges()).toEqual([
      expect.objectContaining({ status: 'superseded', lowValue: '700', highValue: '1400' }),
    ]);
    // Back to the suggestion, at once.
    expect(screen.getByText(en.common['targetRanges.notConfirmed'])).toBeTruthy();
    expect(announce).toHaveBeenCalledWith(copy('targetRanges.announceStop'));
  });

  it('keeps the value when the patient changes their mind', async () => {
    await renderScreen(<TargetRanges />, {
      cached: [range({ provenance: 'patient_set', patientRange: OWN })],
    });

    await press(copy('targetRanges.stopOwnSpoken'));
    await press(copy('targetRanges.stopKeepSpoken'));

    expect(await listQueuedOperations(mockExecutor)).toEqual([]);
    expect(screen.getByLabelText(copy('targetRanges.stopOwnSpoken'))).toBeTruthy();
  });

  /**
   * #147: an unsent value is withdrawn by a queued withdrawal, not deleted, so
   * a create the server may already hold is still withdrawn.
   */
  it('withdraws an unsent value by queuing the withdrawal behind it', async () => {
    await renderScreen(<TargetRanges />, { cached: [range()] });
    await press(copy('targetRanges.useTypicalSpoken'));

    await press(copy('targetRanges.stopOwnSpoken'));
    await press(copy('targetRanges.stopConfirmSpoken'));

    expect((await listQueuedOperations(mockExecutor)).map((op) => op.operationType)).toEqual([
      'create',
      'update',
    ]);
    expect(screen.getByText(en.common['targetRanges.notConfirmed'])).toBeTruthy();
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
    expect(screen.queryByLabelText(copy('targetRanges.useTypicalSpoken'))).toBeNull();

    await press(copy('targetRanges.setOwnSpoken'));
    expect(screen.getByText(en.common['targetRanges.physicianStaysNote'])).toBeTruthy();
    await type(copy('targetRanges.formLowSpoken', { unit: 'milliliters' }), '800');
    await press(copy('targetRanges.formSaveSpoken'));

    expect(screen.getByText(/450 mL to 950 mL/)).toBeTruthy();
    expect(screen.getByText(en.common['targetRanges.divergesFromPhysician'])).toBeTruthy();
  });

  /** WCAG 2.4.6: with several ranges on screen, each button names its own. */
  it('names the measure on every button, so the same buttons on two ranges can be told apart', async () => {
    await renderScreen(<TargetRanges />, {
      cached: [range(), range({ rangeType: 'urine_output_adequacy_ml', highValue: null })],
    });

    expect(screen.getAllByLabelText(copy('targetRanges.setOwnSpoken'))).toHaveLength(1);
    expect(
      screen.getByLabelText(
        copy('targetRanges.setOwnSpoken', {
          measure: en.common['rangeType.urine_output_adequacy_ml'],
        }),
      ),
    ).toBeTruthy();
  });

  it.each([
    ['accepts', 'targetRanges.acceptProposalSpoken', 'active'],
    ['declines', 'targetRanges.dismissProposalSpoken', 'dismissed'],
  ] as const)('%s a range waiting for the patient', async (_verb, button, status) => {
    await renderScreen(<TargetRanges />, {
      cached: [
        range({
          proposal: { ...OWN, id: PROPOSAL_ID, provenance: 'patient_confirmed_suggestion' },
        }),
      ],
    });
    expect(screen.getByText(/A range is waiting for you to decide/)).toBeTruthy();

    await press(copy(button));

    expect(await savedChanges()).toEqual([expect.objectContaining({ id: PROPOSAL_ID, status })]);
    expect(screen.queryByText(/A range is waiting for you to decide/)).toBeNull();
  });

  it('goes back to Settings rather than stacking a new copy of it', async () => {
    await renderScreen(<TargetRanges />, { cached: [range()] });

    await press(en.mobile['navigation.backButton']);

    expect(mockBack).toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

describe('a refused range change in the correction inbox', () => {
  /** "Remove this change" is not a decision anyone can make about a change they cannot identify. */
  it('names the range and the value, and removes the change when asked', async () => {
    await writeProfile(mockExecutor, PROFILE, NOW_ISO);
    const { operationId } = await enqueueRangeCreate(
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
    const problem = copy('corrections.rangeProblemSet', { value: 'At least 800 mL' });
    expect(screen.getByText(problem)).toBeTruthy();

    await press(copy('corrections.rangeDiscardSpoken'));

    expect(await mockExecutor.getAllAsync('SELECT * FROM sync_queue;')).toEqual([]);
    expect(await mockExecutor.getAllAsync('SELECT * FROM range_writes;')).toEqual([]);
    expect(screen.queryByText(problem)).toBeNull();
  });
});
