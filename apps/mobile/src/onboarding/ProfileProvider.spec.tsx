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
 * The gate: whether a signed-in patient reaches their diary or the three
 * questions.
 *
 * Runs against a real SQLite database rather than a mocked repository, because the
 * property under test is "what this DEVICE knows" and the local row is what that
 * means. A mocked `readProfile` would let the provider and the schema disagree
 * about the one fact the gate turns on.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApiError } from '@ostomy/core/api-client';
import { act, render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';

import { runMigrations } from '../db/migrations';
import { readProfile, writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import type { SqliteExecutor } from '../db/executor';
import { createNodeSqliteExecutor } from '../test-support/nodeSqliteExecutor';

import { ProfileProvider, useProfileState } from './ProfileProvider';
import type { ProfilePort } from './provisionProfile';

const PROFILE: LocalProfile = {
  ostomyType: 'ileostomy',
  surgeryDate: '2026-09-01',
  measurementSystem: 'metric',
};

const mockAuth: { phase: string; getFreshAccessToken: () => Promise<string | undefined> } = {
  phase: 'authenticated',
  getFreshAccessToken: async () => 'token',
};
jest.mock('../auth/AuthContext', () => ({
  useAuth: () => mockAuth,
}));

let executor: SqliteExecutor;
const mockDatabase: { status: string; executor: () => SqliteExecutor } = {
  status: 'ready',
  executor: () => executor,
};
jest.mock('../db/DatabaseProvider', () => ({
  useDatabaseState: () => ({ status: mockDatabase.status, executor: mockDatabase.executor() }),
}));

/** Renders the gate's current status and the reads it took, so a test asserts behaviour rather than internals. */
function GateProbe(): React.JSX.Element {
  const { state } = useProfileState();
  return (
    <>
      <Text>{`status:${state.status}`}</Text>
      {state.status === 'present' ? <Text>{`date:${state.profile.surgeryDate}`}</Text> : null}
    </>
  );
}

function port(overrides: Partial<ProfilePort> = {}): ProfilePort {
  return {
    provision: () => Promise.resolve(PROFILE),
    read: () => Promise.resolve(PROFILE),
    ...overrides,
  };
}

const notProvisioned = () =>
  Promise.reject(new ApiError(403, { error: { code: 'PATIENT_NOT_PROVISIONED' } }));

/**
 * Renders and lets the gate settle inside one `act` scope.
 *
 * The settling matters: the check is asynchronous — a SQLite read, then possibly a
 * request — so a bare `render` returns with the gate still `checking` and the real
 * state arrives in a later microtask, outside any `act`. React warns about exactly
 * that, and the warning is worth heeding rather than silencing: an assertion made
 * before the state lands would be asserting the loading screen.
 */
async function renderGate(
  element: React.JSX.Element,
): Promise<ReturnType<typeof render> | undefined> {
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(element);
  });
  return result;
}

describe('ProfileProvider', () => {
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ostomy-mobile-gate-'));
    executor = createNodeSqliteExecutor(join(dir, 'test.db'));
    await runMigrations(executor, () => new Date('2026-10-08T12:00:00.000Z'));
    mockAuth.phase = 'authenticated';
    mockDatabase.status = 'ready';
  });

  afterEach(async () => {
    await executor.closeAsync();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The offline case, and the reason the local row is read first: a patient who
   * unlocks on a plane must reach their diary. It also means a provisioned patient
   * costs no request at launch, so a server outage cannot lock them out of entries
   * that live on their own phone.
   */
  it('reports present from the local row without asking the server', async () => {
    await writeProfile(executor, PROFILE, '2026-10-08T12:00:00.000Z');
    const read = jest.fn(() => Promise.resolve(PROFILE));

    await renderGate(
      <ProfileProvider port={port({ read })}>
        <GateProbe />
      </ProfileProvider>,
    );

    expect(screen.getByText('status:present')).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });

  it('reports absent when the server says this patient is not provisioned', async () => {
    await renderGate(
      <ProfileProvider port={port({ read: notProvisioned })}>
        <GateProbe />
      </ProfileProvider>,
    );

    expect(screen.getByText('status:absent')).toBeTruthy();
  });

  /**
   * The distinction this provider exists for. A device with no local row is not
   * evidence of a new patient — a reinstall, a new phone, or an ADR-0014 purge all
   * produce it for someone who onboarded months ago — so an unreachable server must
   * not be read as "new". Reporting `absent` here would walk such a patient through
   * a form whose submit can only answer 409, and invite them to re-state a surgery
   * date that is already recorded.
   */
  it.each([
    ['a network failure', () => Promise.reject(new TypeError('Network request failed'))],
    ['a 500', () => Promise.reject(new ApiError(500, {}))],
  ])('reports unreachable rather than absent on %s', async (_label, read) => {
    await renderGate(
      <ProfileProvider port={port({ read })}>
        <GateProbe />
      </ProfileProvider>,
    );

    expect(screen.getByText('status:unreachable')).toBeTruthy();
  });

  /**
   * A patient who onboarded on another device, or reinstalled. Recording the
   * server's profile locally is what keeps the next launch from asking again — and
   * what makes the surgery date available to Tier 1 validation offline.
   */
  it('adopts a profile the server has but this device does not', async () => {
    const serverProfile: LocalProfile = { ...PROFILE, surgeryDate: '2025-05-05' };

    await renderGate(
      <ProfileProvider port={port({ read: () => Promise.resolve(serverProfile) })}>
        <GateProbe />
      </ProfileProvider>,
    );

    expect(screen.getByText('date:2025-05-05')).toBeTruthy();
    await expect(readProfile(executor)).resolves.toEqual(serverProfile);
  });

  /**
   * `locked` and `signedOut` have no access token, so a lookup would 401 and report
   * `unreachable` — which the onboarding screen then explains as a connection
   * problem to someone who is simply not signed in yet.
   */
  it.each([['locked'], ['signedOut'], ['checking']])(
    'stays checking and asks nothing while the phase is %s',
    async (phase) => {
      mockAuth.phase = phase;
      const read = jest.fn(() => Promise.resolve(PROFILE));

      await renderGate(
        <ProfileProvider port={port({ read })}>
          <GateProbe />
        </ProfileProvider>,
      );

      expect(screen.getByText('status:checking')).toBeTruthy();
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('stays checking until the database is open, since the local row is read first', async () => {
    mockDatabase.status = 'opening';
    const read = jest.fn(() => Promise.resolve(PROFILE));

    await renderGate(
      <ProfileProvider port={port({ read })}>
        <GateProbe />
      </ProfileProvider>,
    );

    expect(screen.getByText('status:checking')).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });

  describe('refresh', () => {
    /** The onboarding screen's retry: the same check again, which is what makes an `unreachable` recoverable without a relaunch. */
    it('re-checks and reaches present once the server answers', async () => {
      let fail = true;
      const read = jest.fn(() =>
        fail ? Promise.reject(new ApiError(500, {})) : Promise.resolve(PROFILE),
      );

      function RetryProbe(): React.JSX.Element {
        const { state, refresh } = useProfileState();
        return (
          <>
            <Text>{`status:${state.status}`}</Text>
            <Text
              onPress={() => {
                void refresh();
              }}
            >
              retry
            </Text>
          </>
        );
      }

      await renderGate(
        <ProfileProvider port={port({ read })}>
          <RetryProbe />
        </ProfileProvider>,
      );
      expect(screen.getByText('status:unreachable')).toBeTruthy();

      fail = false;
      await act(async () => {
        screen.getByText('retry').props.onPress();
      });

      expect(screen.getByText('status:present')).toBeTruthy();
    });
  });

  describe('adopt', () => {
    /**
     * The row is written BEFORE the gate opens. The dashboard reads the local row, so
     * a `present` state ahead of the write would render one frame against a profile
     * that is not there — and on a slow device that frame is what the patient sees.
     */
    it('writes the row before reporting present', async () => {
      function AdoptProbe(): React.JSX.Element {
        const { state, adopt } = useProfileState();
        return (
          <>
            <Text>{`status:${state.status}`}</Text>
            <Text
              onPress={() => {
                void adopt(PROFILE);
              }}
            >
              adopt
            </Text>
          </>
        );
      }

      await renderGate(
        <ProfileProvider port={port({ read: notProvisioned })}>
          <AdoptProbe />
        </ProfileProvider>,
      );
      expect(screen.getByText('status:absent')).toBeTruthy();

      await act(async () => {
        screen.getByText('adopt').props.onPress();
      });

      expect(screen.getByText('status:present')).toBeTruthy();
      await expect(readProfile(executor)).resolves.toEqual(PROFILE);
    });
  });
});
