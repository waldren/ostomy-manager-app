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
 * Tests for the auth provider.
 *
 * This module had none, and that is why a code review found five defects in
 * it — every one of which a single test here would have caught. Each block
 * below names the failure it holds down.
 */

import { act, render, screen, waitFor } from '@testing-library/react-native';
import { Text } from 'react-native';

import { AuthProvider, useAuth } from './AuthContext';

const mockHasStored = jest.fn(async () => true);
const mockGetRefresh = jest.fn(async () => 'rt' as string | null);
const mockClearRefresh = jest.fn(async () => undefined);
const mockSetRefresh = jest.fn(async (_token: string) => undefined);
const mockTokenIsStale = jest.fn(async () => false);
const mockRecordReason = jest.fn(async (_reason: string) => undefined);
const mockReadReason = jest.fn(async () => null as string | null);
const mockClearReason = jest.fn(async () => undefined);

jest.mock('./tokenStorage', () => ({
  hasStoredRefreshToken: () => mockHasStored(),
  getRefreshToken: () => mockGetRefresh(),
  clearRefreshToken: () => mockClearRefresh(),
  setRefreshToken: (t: string) => mockSetRefresh(t),
  storedTokenIsStaleForEnrolment: () => mockTokenIsStale(),
  recordSignedOutReason: (r: string) => mockRecordReason(r),
  readSignedOutReason: () => mockReadReason(),
  clearSignedOutReason: () => mockClearReason(),
}));

const mockPurge = jest.fn(async () => undefined);
jest.mock('../db/purge', () => ({ purgeLocalDatabase: () => mockPurge() }));

const mockGetOwner = jest.fn(async () => null as string | null);
const mockSetOwner = jest.fn(async (_subject: string) => undefined);
jest.mock('../db/databaseOwner', () => ({
  getDatabaseOwner: () => mockGetOwner(),
  setDatabaseOwner: (s: string) => mockSetOwner(s),
}));

const mockRevoke = jest.fn(async () => undefined);
jest.mock('./oidcSession', () => ({
  useAutoDiscovery: () => ({ tokenEndpoint: 'https://issuer.example/token' }),
  refreshAccessToken: jest.fn(async () => ({ accessToken: 'fresh', refreshToken: 'rt2' })),
  revokeRefreshToken: () => mockRevoke(),
}));

jest.mock('./oidcConfig', () => ({
  getOidcClientConfig: () => ({ issuer: 'https://issuer.example', clientId: 'ostomy-mobile' }),
}));

const mockAuthenticate = jest.fn(
  async (_prompt: string) => ({ outcome: 'success' }) as { outcome: string },
);
jest.mock('./biometricUnlock', () => ({
  authenticate: (prompt: string) => mockAuthenticate(prompt),
  isLocalUnlockAvailable: jest.fn(async () => true),
  enrolledSecurityLevel: jest.fn(async () => 3),
}));

function Probe() {
  const { phase, signOut, completeLogin, unlock, signedOutReason } = useAuth();
  return (
    <>
      <Text testID="phase">{phase}</Text>
      <Text testID="signout" onPress={() => void signOut()}>
        sign out
      </Text>
      <Text testID="unlock" onPress={() => void unlock()}>
        unlock
      </Text>
      <Text testID="reason">{signedOutReason ?? 'none'}</Text>
      <Text
        testID="login"
        onPress={() =>
          void completeLogin({
            accessToken: 'opaque-access-token',
            refreshToken: 'rt',
            idToken: makeJwt({ sub: 'patient-a' }),
            expiresAtSeconds: undefined,
          })
        }
      >
        log in
      </Text>
    </>
  );
}

function makeJwt(payload: unknown): string {
  const encode = (value: string) =>
    Buffer.from(value, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode('{"alg":"none"}')}.${encode(JSON.stringify(payload))}.sig`;
}

async function renderProvider() {
  // Wrapped in `act` because the provider's mount effect resolves a promise
  // and calls `setPhase` outside any event handler.
  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    );
  });
  return result;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockHasStored.mockResolvedValue(true);
  mockGetRefresh.mockResolvedValue('rt');
  mockGetOwner.mockResolvedValue(null);
  mockAuthenticate.mockResolvedValue({ outcome: 'success' });
  mockTokenIsStale.mockResolvedValue(false);
  mockReadReason.mockResolvedValue(null);
});

describe('cold start never wedges on a spinner', () => {
  /**
   * `hasStoredRefreshToken` used to read the token itself, which after
   * `requireAuthentication` became a biometric-gated read. A patient who
   * cancelled that sheet — or whose biometry was locked out, or whose key
   * the OS had invalidated — got a rejection with no error path: `phase`
   * stayed `'checking'` and the app rendered its loading spinner forever,
   * with no way out but reinstalling, which destroys the database.
   */
  it('falls back to locked when the presence check rejects', async () => {
    mockHasStored.mockRejectedValueOnce(new Error('keychain unavailable'));

    await renderProvider();

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));
  });

  it('does NOT fall back to signedOut, which would strand an offline patient', async () => {
    // A briefly unreadable keychain says nothing about whether a token
    // exists. Routing to `signedOut` pushes the patient into a network OIDC
    // login they may be unable to complete, for a session they already have.
    mockHasStored.mockRejectedValueOnce(new Error('keychain unavailable'));

    await renderProvider();

    // `not.toHaveTextContent('signedOut')` on a node already asserted to
    // read 'locked' cannot fail independently. Assert the fallback is a
    // phase the patient can act on offline instead.
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));
    expect(['locked', 'authenticated']).toContain(screen.getByTestId('phase').props.children);
  });
});

describe('sign-out cannot be aborted', () => {
  /**
   * The unguarded `await getRefreshToken()` was the FIRST statement, and it
   * prompts for biometrics. A patient who dismissed that sheet got a
   * rejection before the token was cleared and before the database was
   * purged — so sign-out silently did nothing, and they handed the phone
   * over with the refresh token and the whole diary still on it.
   */
  it('clears the token and purges even when the token read rejects', async () => {
    mockGetRefresh.mockRejectedValueOnce(new Error('user cancelled biometric prompt'));

    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));

    await act(async () => {
      screen.getByTestId('signout').props.onPress();
    });

    expect(mockClearRefresh).toHaveBeenCalled();
    expect(mockPurge).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('signedOut'));
  });

  it('still reaches signedOut when the purge itself fails', async () => {
    // A failure anywhere must not leave the app showing the previous
    // patient's session.
    mockPurge.mockRejectedValueOnce(new Error('delete failed'));

    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));

    await act(async () => {
      screen.getByTestId('signout').props.onPress();
    });

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('signedOut'));
  });

  it('does not let a failed revocation block the token clear or the purge', async () => {
    // This assertion used to be `phase === 'signedOut'` alone — which the
    // `finally` guarantees unconditionally, so it passed with the purge
    // removed entirely. It has to name the steps that must still happen.
    mockRevoke.mockRejectedValueOnce(new Error('offline'));

    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));

    await act(async () => {
      screen.getByTestId('signout').props.onPress();
    });

    expect(mockClearRefresh).toHaveBeenCalled();
    expect(mockPurge).toHaveBeenCalled();
  });

  it('still purges when clearing the token fails', async () => {
    /**
     * The three steps shared one `try`, so a throw from any of them skipped
     * the rest. A `SecureStore.deleteItemAsync` failure is entirely
     * reachable, and it left BOTH the refresh token and the whole local
     * diary on the device while the UI reported a signed-out session —
     * which is exactly the HIPAA finding this code was written to close.
     */
    mockClearRefresh.mockRejectedValueOnce(new Error('keychain write failed'));

    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));

    await act(async () => {
      screen.getByTestId('signout').props.onPress();
    });

    expect(mockPurge).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('signedOut'));
  });
});

describe('database ownership is decided from the ID token', () => {
  /**
   * OIDC guarantees the id_token is a JWT with a `sub`; an access token's
   * format is provider-defined and may be opaque. Parsing the access token
   * meant that against such an issuer the subject was `undefined` on EVERY
   * login, the owner was never stored, and every routine sign-in purged the
   * diary — including the same patient's, destroying unsynced entries.
   */
  it('stores the owner from the id_token even when the access token is opaque', async () => {
    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));

    await act(async () => {
      screen.getByTestId('login').props.onPress();
    });

    await waitFor(() => expect(mockSetOwner).toHaveBeenCalledWith('patient-a'));
  });

  it('purges when the stored owner is a different patient', async () => {
    mockGetOwner.mockResolvedValue('patient-b');

    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));

    await act(async () => {
      screen.getByTestId('login').props.onPress();
    });

    await waitFor(() => expect(mockPurge).toHaveBeenCalled());
  });

  it('does NOT purge when the same patient signs in again', async () => {
    // The routine re-login. Purging here destroys the patient's own
    // unsynced entries for no reason, which is what the access-token bug
    // did on every login against an opaque-token issuer.
    mockGetOwner.mockResolvedValue('patient-a');

    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));

    await act(async () => {
      screen.getByTestId('login').props.onPress();
    });

    await waitFor(() => expect(mockSetOwner).toHaveBeenCalled());
    expect(mockPurge).not.toHaveBeenCalled();
  });
});

/**
 * #74. This app's own prompt is the gate, and for an ungated token it is the
 * ONLY thing standing in front of the diary.
 *
 * `tokenStorage.ts` always documented the division of labour —
 * `requireAuthentication` is there for the OS invalidation signal, not for the
 * prompt, because `unlock()` calls `authenticate()` itself. On a device with no
 * biometric enrolled the token is now stored without that flag, so the SecureStore
 * read no longer prompts either. That makes the claim load-bearing rather than
 * merely true, and nothing was asserting it.
 */
describe('unlock is gated by this app, not by the keychain read (#74)', () => {
  it('does not reach an authenticated session when the prompt fails', async () => {
    mockAuthenticate.mockResolvedValue({ outcome: 'failed' });

    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));

    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });

    expect(screen.getByTestId('phase')).toHaveTextContent('locked');
  });

  it('does not read the stored token when the prompt fails', async () => {
    // The read is inside the success branch. If it ever moves ahead of the
    // prompt, an ungated token is handed over with no authentication at all —
    // and on a gated one the OS sheet would appear before this app's own.
    mockAuthenticate.mockResolvedValue({ outcome: 'failed' });

    await renderProvider();
    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });

    expect(mockGetRefresh).not.toHaveBeenCalled();
  });

  it('reaches an authenticated session when the prompt succeeds', async () => {
    // The counterpart, so the two tests above cannot pass by unlock being broken.
    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));

    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });

    expect(screen.getByTestId('phase')).toHaveTextContent('authenticated');
  });
});

/**
 * #74 and the code reviewer's finding 4: an Android process can live for days, so a
 * cold-start check alone leaves a window open.
 *
 * Without this, someone who enrols their own biometric while the process is alive
 * opens the app at the lock screen, satisfies the OS prompt with the print they
 * just added, and the token read hands them a live bearer credential — no purge, no
 * issuer round trip, nothing recorded anywhere. The gated case has no such window,
 * because the OS invalidates the key the moment the enrolment lands.
 */
describe('unlock re-checks enrolment, not only cold start', () => {
  it('purges and routes to sign-in instead of unlocking', async () => {
    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));

    // Becomes true only after the app is already running, which is the point.
    mockTokenIsStale.mockResolvedValue(true);
    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });

    expect(screen.getByTestId('phase')).toHaveTextContent('signedOut');
    expect(mockClearRefresh).toHaveBeenCalled();
  });

  it('does not hand over the stored token', async () => {
    await renderProvider();
    mockTokenIsStale.mockResolvedValue(true);

    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });

    expect(mockGetRefresh).not.toHaveBeenCalled();
  });

  /**
   * The gated half, detected from the read rather than guessed from the level.
   *
   * An invalidated keystore key yields nothing. The early return here used to leave
   * the patient in `authenticated` with no access token and no route to re-login:
   * sync silently never worked again while every screen truthfully reported entries
   * saved. Reachable only since local unlock started accepting the device passcode.
   */
  it('signs out when the stored token has been invalidated by the OS', async () => {
    mockGetRefresh.mockResolvedValue(null);

    await renderProvider();
    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });

    expect(screen.getByTestId('phase')).toHaveTextContent('signedOut');
    expect(mockRecordReason).toHaveBeenCalledWith('unlock-settings-changed');
    expect(mockClearRefresh).toHaveBeenCalled();
  });

  it('still unlocks when the check itself fails', async () => {
    // An unreadable keychain says nothing about enrolment, and refusing to unlock on
    // that evidence would strand an offline patient.
    await renderProvider();
    mockTokenIsStale.mockRejectedValue(new Error('keychain unavailable'));

    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });

    expect(screen.getByTestId('phase')).toHaveTextContent('authenticated');
  });
});

/**
 * #74. An ungated token records the enrolment level it was written at, and a rise
 * means a biometric was enrolled since — ADR-0015's covert-enrolment threat, and
 * the one form of the change an app can actually observe.
 */
describe('a token invalidated by a new enrolment does not survive the next launch', () => {
  it('purges it and routes to a full sign-in', async () => {
    mockTokenIsStale.mockResolvedValue(true);
    // Answers from whether the purge has actually run, rather than a static
    // `false`: with a static answer this test cannot tell "the phase was derived
    // after the purge" from "the two raced and the presence check happened to lose",
    // which is the whole thing it is here to pin.
    mockHasStored.mockImplementation(async () => mockClearRefresh.mock.calls.length === 0);

    await renderProvider();

    expect(mockClearRefresh).toHaveBeenCalled();
    expect(mockClearRefresh.mock.invocationCallOrder[0]!).toBeLessThan(
      mockHasStored.mock.invocationCallOrder[0]!,
    );
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('signedOut'));
  });

  it('records why, so the login screen is not a bare sign-in prompt', async () => {
    mockTokenIsStale.mockResolvedValue(true);
    mockHasStored.mockImplementation(async () => mockClearRefresh.mock.calls.length === 0);

    await renderProvider();

    expect(mockRecordReason).toHaveBeenCalledWith('unlock-settings-changed');
    // Before the purge: a recorded reason for a sign-out that did not happen is
    // merely confusing, while a sign-out with no reason is the defect being fixed.
    expect(mockRecordReason.mock.invocationCallOrder[0]!).toBeLessThan(
      mockClearRefresh.mock.invocationCallOrder[0]!,
    );
  });

  it('surfaces a reason persisted by an earlier launch', async () => {
    // The remedy is a NETWORK login, so an offline patient closes the app and comes
    // back. The explanation has to survive that, which is why it is not React state.
    mockReadReason.mockResolvedValue('unlock-settings-changed');
    mockHasStored.mockResolvedValue(false);

    const { getByTestId } = await renderProvider();

    await waitFor(() => expect(getByTestId('reason')).toHaveTextContent('unlock-settings-changed'));
  });

  it('clears the reason once a sign-in actually succeeds', async () => {
    mockReadReason.mockResolvedValue('unlock-settings-changed');
    mockHasStored.mockResolvedValue(false);

    await renderProvider();
    await act(async () => {
      screen.getByTestId('login').props.onPress();
    });

    expect(mockClearReason).toHaveBeenCalled();
  });

  it('leaves the session alone when nothing has changed', async () => {
    await renderProvider();

    expect(mockClearRefresh).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));
  });

  it('keeps the session when the staleness check itself fails', async () => {
    // A keychain that cannot be read says nothing about enrolment. Purging on
    // that evidence would push an offline patient into a network login they
    // cannot complete — the same failure the cold-start fallback above avoids.
    mockTokenIsStale.mockRejectedValue(new Error('keychain unavailable'));

    await renderProvider();

    expect(mockClearRefresh).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));
  });
});
