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
 * The onboarding screen (P4.S1 slice 2, SRS §3.0).
 *
 * Lives beside the module it exercises rather than under `app/`, matching where
 * the entry screens' tests sit. It drives the real `ProfileProvider` against a real
 * SQLite database and stubs only the network port, because the two things most
 * worth asserting here both cross that boundary: what gets SENT (three fields, none
 * invented) and what the patient is told when the answer comes back.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Side-effect import: initialises the single i18next instance, exactly as
// `app/_layout.tsx` does in the app. Without it every `t()` returns the raw key
// and the assertions below fail for a reason that looks like broken copy.
import '../i18n/i18n';

import { ApiError } from '@ostomy/core/api-client';
import { en } from '@ostomy/core/i18n';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import Onboarding from '../../app/onboarding';
import { runMigrations } from '../db/migrations';
import { readProfile, type LocalProfile } from '../db/repositories/profileRepository';
import type { SqliteExecutor } from '../db/executor';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { ProfileProvider } from './ProfileProvider';
import type { ProfilePort } from './provisionProfile';

const PROFILE: LocalProfile = {
  ostomyType: 'ileostomy',
  surgeryDate: '2026-09-01',
  measurementSystem: 'metric',
};

const mockAuth = { phase: 'authenticated', getFreshAccessToken: async () => 'token' };
jest.mock('../auth/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

// Named `mockExecutor` because jest's module factory may only close over
// variables whose names start with `mock` — the guard against an uninitialised
// mock, which this genuinely is until `beforeEach` opens the database.
let mockExecutor: SqliteExecutor;
jest.mock('../db/DatabaseProvider', () => ({
  useDatabaseState: () => ({ status: 'ready', executor: mockExecutor }),
}));

const mockReplace = jest.fn();
// `mock`-prefixed for jest's module-factory rule, same as `mockExecutor` above.
let mockSearchParams: Record<string, string> = {};
jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    router: { replace: (href: string) => mockReplace(href), push: jest.fn() },
    useLocalSearchParams: () => mockSearchParams,
    // Rendered as visible text so a test can assert WHERE the screen sent the
    // patient, which is the whole behaviour of the two redirect branches.
    Redirect: ({ href }: { href: string }) => <Text>{`redirect:${href}`}</Text>,
  };
});

/**
 * The device's own date, frozen. The screen compares the entered date against this
 * to decide "in the future", so a test that let it float would assert a different
 * rule tomorrow.
 */
jest.mock('../lib/utils/clock', () => ({
  now: () => new Date('2026-10-08T12:00:00.000Z'),
  deviceTimeZone: () => 'UTC',
  toWireInstant: (date: Date) => date.toISOString(),
}));

const notProvisioned = () =>
  Promise.reject(new ApiError(403, { error: { code: 'PATIENT_NOT_PROVISIONED' } }));

function port(overrides: Partial<ProfilePort> = {}): ProfilePort {
  return {
    provision: () => Promise.resolve(PROFILE),
    read: notProvisioned,
    ...overrides,
  };
}

/** Renders inside the real gate and lets its asynchronous check settle. */
async function renderScreen(profilePort: ProfilePort): Promise<void> {
  await act(async () => {
    render(
      <ProfileProvider port={profilePort}>
        <Onboarding />
      </ProfileProvider>,
    );
  });
}

/**
 * Presses by accessible label, through `fireEvent`.
 *
 * By label rather than by text, and `fireEvent` rather than calling `onPress`
 * directly, because both are what a patient's tap actually goes through: the
 * visible text is a child of the `Pressable`, so a direct call would have to reach
 * for an ancestor and would pass even if the control were not pressable at all.
 */
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

/** Fills in all three answers with a valid, unremarkable set. */
async function answerEverything(): Promise<void> {
  await press(en.common['ostomyType.ileostomy']);
  await type(en.common['onboarding.surgeryDateDayLabel'], '01');
  await type(en.common['onboarding.surgeryDateMonthLabel'], '09');
  await type(en.common['onboarding.surgeryDateYearLabel'], '2026');
  await press(en.common['measurementSystem.metric']);
}

describe('onboarding screen', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-onboarding-'));
    mockExecutor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(mockExecutor, () => new Date('2026-10-08T12:00:00.000Z'));
    mockSearchParams = {};
    mockReplace.mockClear();
  });

  afterEach(async () => {
    await mockExecutor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks all three questions and offers both options for each', async () => {
    await renderScreen(port());

    expect(screen.getByText(en.common['onboarding.ostomyTypeLabel'])).toBeTruthy();
    expect(screen.getByText(en.common['onboarding.surgeryDateLabel'])).toBeTruthy();
    expect(screen.getByText(en.common['onboarding.measurementSystemLabel'])).toBeTruthy();
    expect(screen.getByText(en.common['ostomyType.colostomy'])).toBeTruthy();
    expect(screen.getByText(en.common['ostomyType.ileostomy'])).toBeTruthy();
    expect(screen.getByText(en.common['measurementSystem.metric'])).toBeTruthy();
    expect(screen.getByText(en.common['measurementSystem.imperial'])).toBeTruthy();
  });

  /**
   * Nothing is pre-selected, and each of the three has its own reason: an ostomy type
   * decides which expected ranges the patient is measured against, the surgery date
   * becomes the Tier 1 lower bound on every entry they make, and the measurement
   * system is ADR-0012's assertion about what the patient themselves typed. A
   * default would be indistinguishable afterwards from an answer.
   */
  it('starts with no option chosen', async () => {
    await renderScreen(port());

    for (const radio of screen.getAllByRole('radio')) {
      expect(radio.props.accessibilityState.checked).toBe(false);
    }
  });

  it('refuses to submit until all three are answered, and says which is missing', async () => {
    const provision = jest.fn(() => Promise.resolve(PROFILE));
    await renderScreen(port({ provision }));

    await press(en.common['onboarding.saveButton']);

    expect(provision).not.toHaveBeenCalled();
    expect(screen.getByText(en.common['onboarding.ostomyTypeRequired'])).toBeTruthy();
    expect(screen.getByText(en.common['onboarding.surgeryDateRequired'])).toBeTruthy();
    expect(screen.getByText(en.common['onboarding.measurementSystemRequired'])).toBeTruthy();
  });

  it('says nothing about a missing answer before the first attempt', async () => {
    await renderScreen(port());

    expect(screen.queryByText(en.common['onboarding.ostomyTypeRequired'])).toBeNull();
    expect(screen.queryByText(en.common['onboarding.surgeryDateRequired'])).toBeNull();
  });

  it('sends exactly the three fields, in the wire shapes the API takes', async () => {
    const sent: unknown[] = [];
    await renderScreen(
      port({
        provision: (body) => {
          sent.push(body);
          return Promise.resolve(PROFILE);
        },
      }),
    );

    await answerEverything();
    await press(en.common['onboarding.saveButton']);

    expect(sent).toEqual([
      { ostomyType: 'ileostomy', surgeryDate: '2026-09-01', measurementSystem: 'metric' },
    ]);
  });

  /**
   * ADR-0004's imperial path has never been reachable in the running app, because
   * `DEFAULT_MEASUREMENT_SYSTEM` was a constant. This is the first place a patient
   * can choose it, so it is worth asserting that the choice actually travels.
   */
  it('carries an imperial choice through to the request', async () => {
    const sent: unknown[] = [];
    await renderScreen(
      port({
        provision: (body) => {
          sent.push(body);
          return Promise.resolve({ ...PROFILE, measurementSystem: 'imperial' });
        },
      }),
    );

    await press(en.common['ostomyType.colostomy']);
    await type(en.common['onboarding.surgeryDateDayLabel'], '01');
    await type(en.common['onboarding.surgeryDateMonthLabel'], '09');
    await type(en.common['onboarding.surgeryDateYearLabel'], '2026');
    await press(en.common['measurementSystem.imperial']);
    await press(en.common['onboarding.saveButton']);

    expect(sent).toEqual([
      { ostomyType: 'colostomy', surgeryDate: '2026-09-01', measurementSystem: 'imperial' },
    ]);
  });

  it('records the profile on this device and goes to the dashboard', async () => {
    await renderScreen(port());

    await answerEverything();
    await press(en.common['onboarding.saveButton']);

    await expect(readProfile(mockExecutor)).resolves.toEqual(PROFILE);
    expect(mockReplace).toHaveBeenCalledWith('/home');
  });

  describe('a refused surgery date', () => {
    /**
     * The device deliberately does not know the fifty-year bound, so this message can
     * only come from the server. Without it the patient gets a generic failure on the
     * one field they could fix.
     */
    it('shows the server’s rule against the date field', async () => {
      await renderScreen(
        port({
          provision: () =>
            Promise.reject(
              new ApiError(400, {
                error: {
                  code: 'INVALID_ONBOARDING',
                  fields: [{ field: 'surgeryDate', rule: 'implausibly_old' }],
                },
              }),
            ),
        }),
      );

      await answerEverything();
      await press(en.common['onboarding.saveButton']);

      expect(screen.getByText(en.common['onboarding.surgeryDateImplausiblyOld'])).toBeTruthy();
    });

    it('clears that message once the patient edits the date', async () => {
      await renderScreen(
        port({
          provision: () =>
            Promise.reject(
              new ApiError(400, {
                error: {
                  code: 'INVALID_ONBOARDING',
                  fields: [{ field: 'surgeryDate', rule: 'implausibly_old' }],
                },
              }),
            ),
        }),
      );

      await answerEverything();
      await press(en.common['onboarding.saveButton']);
      await type(en.common['onboarding.surgeryDateYearLabel'], '2025');

      expect(screen.queryByText(en.common['onboarding.surgeryDateImplausiblyOld'])).toBeNull();
    });

    /**
     * Caught here rather than at the server, because the device knows its own
     * timezone and can be exact where the server has to allow the furthest-ahead
     * zone.
     */
    it('refuses a date after the device’s own today without asking the server', async () => {
      const provision = jest.fn(() => Promise.resolve(PROFILE));
      await renderScreen(port({ provision }));

      await press(en.common['ostomyType.ileostomy']);
      await type(en.common['onboarding.surgeryDateDayLabel'], '09');
      await type(en.common['onboarding.surgeryDateMonthLabel'], '10');
      await type(en.common['onboarding.surgeryDateYearLabel'], '2026');
      await press(en.common['measurementSystem.metric']);
      await press(en.common['onboarding.saveButton']);

      expect(provision).not.toHaveBeenCalled();
      expect(screen.getByText(en.common['onboarding.surgeryDateInTheFuture'])).toBeTruthy();
    });

    it('accepts the device’s own today, which is the hospital-bed case', async () => {
      const provision = jest.fn(() => Promise.resolve(PROFILE));
      await renderScreen(port({ provision }));

      await press(en.common['ostomyType.ileostomy']);
      await type(en.common['onboarding.surgeryDateDayLabel'], '08');
      await type(en.common['onboarding.surgeryDateMonthLabel'], '10');
      await type(en.common['onboarding.surgeryDateYearLabel'], '2026');
      await press(en.common['measurementSystem.metric']);
      await press(en.common['onboarding.saveButton']);

      expect(provision).toHaveBeenCalledTimes(1);
    });
  });

  describe('when the request cannot be delivered', () => {
    /**
     * Unknown fate (`docs/sync-contract.md` §9.3's category, applied to the one write
     * that is not queued). The answers stay on screen, so a retry is one tap rather
     * than three fields retyped.
     */
    it('says so, keeps the answers, and offers no false promise of a later send', async () => {
      await renderScreen(
        port({ provision: () => Promise.reject(new TypeError('Network request failed')) }),
      );

      await answerEverything();
      await press(en.common['onboarding.saveButton']);

      expect(screen.getByText(en.common['onboarding.unreachableBody'])).toBeTruthy();
      expect(screen.getByLabelText(en.common['onboarding.surgeryDateYearLabel']).props.value).toBe(
        '2026',
      );
      await expect(readProfile(mockExecutor)).resolves.toBeUndefined();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('reports a dead end differently from a retryable one', async () => {
      await renderScreen(port({ provision: () => Promise.reject(new ApiError(401, {})) }));

      await answerEverything();
      await press(en.common['onboarding.saveButton']);

      expect(screen.getByText(en.common['onboarding.failedBody'])).toBeTruthy();
    });
  });

  describe('the gate decides what this screen shows', () => {
    /**
     * The questions are NOT asked when the gate could not reach the server. A device
     * with no local profile is not evidence of a new patient — a reinstall produces
     * the same thing — so asking here would walk someone already provisioned through
     * a form whose submit can only answer 409.
     */
    it('shows a connection notice instead of the questions when the gate is unreachable', async () => {
      await renderScreen(port({ read: () => Promise.reject(new ApiError(500, {})) }));

      expect(screen.getByText(en.common['onboarding.unreachableHeading'])).toBeTruthy();
      expect(screen.queryByText(en.common['onboarding.ostomyTypeLabel'])).toBeNull();
    });

    it('asks the questions again after a retry finds the patient is new', async () => {
      let fail = true;
      await renderScreen(
        port({
          read: () => (fail ? Promise.reject(new ApiError(500, {})) : notProvisioned()),
        }),
      );
      expect(screen.getByText(en.common['onboarding.unreachableHeading'])).toBeTruthy();

      fail = false;
      await press(en.common['onboarding.retryButton']);

      expect(screen.getByText(en.common['onboarding.ostomyTypeLabel'])).toBeTruthy();
    });

    it('sends a patient who already has a profile back to the dashboard', async () => {
      await renderScreen(port({ read: () => Promise.resolve(PROFILE) }));

      expect(screen.getByText('redirect:/home')).toBeTruthy();
    });

    it('sends a patient who is not signed in to the login screen', async () => {
      mockAuth.phase = 'locked';
      await renderScreen(port());
      mockAuth.phase = 'authenticated';

      expect(screen.getByText('redirect:/login')).toBeTruthy();
    });
  });

  describe('?again=1 — re-provisioning after the server lost the profile', () => {
    /**
     * Reachable from the dashboard when the sync worker reports
     * `PATIENT_NOT_PROVISIONED` while this device still holds a profile. Without the
     * parameter the screen would redirect to the dashboard and the button would
     * appear to do nothing.
     */
    it('asks the questions even though a profile is present', async () => {
      mockSearchParams = { again: '1' };
      await renderScreen(port({ read: () => Promise.resolve(PROFILE) }));

      expect(screen.queryByText('redirect:/home')).toBeNull();
      expect(screen.getByText(en.common['onboarding.ostomyTypeLabel'])).toBeTruthy();
    });

    it('pre-fills every answer from the local row, so the patient confirms rather than retypes', async () => {
      mockSearchParams = { again: '1' };
      await renderScreen(port({ read: () => Promise.resolve(PROFILE) }));

      expect(screen.getByLabelText(en.common['onboarding.surgeryDateYearLabel']).props.value).toBe(
        '2026',
      );
      expect(screen.getByLabelText(en.common['onboarding.surgeryDateMonthLabel']).props.value).toBe(
        '09',
      );
      expect(screen.getByLabelText(en.common['onboarding.surgeryDateDayLabel']).props.value).toBe(
        '01',
      );

      const checked = screen
        .getAllByRole('radio')
        .filter((radio) => radio.props.accessibilityState.checked)
        .map((radio) => radio.props.accessibilityLabel);
      expect(checked).toEqual([
        en.common['ostomyType.ileostomy'],
        en.common['measurementSystem.metric'],
      ]);
    });
  });
});
