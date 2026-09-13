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

jest.mock('./tokenStorage', () => ({
  hasStoredRefreshToken: () => mockHasStored(),
  getRefreshToken: () => mockGetRefresh(),
  clearRefreshToken: () => mockClearRefresh(),
  setRefreshToken: (t: string) => mockSetRefresh(t),
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

jest.mock('./biometricUnlock', () => ({
  authenticate: jest.fn(async () => ({ outcome: 'success' })),
  isBiometricUnlockAvailable: jest.fn(async () => true),
}));

function Probe() {
  const { phase, signOut, completeLogin } = useAuth();
  return (
    <>
      <Text testID="phase">{phase}</Text>
      <Text testID="signout" onPress={() => void signOut()}>
        sign out
      </Text>
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

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));
    expect(screen.getByTestId('phase')).not.toHaveTextContent('signedOut');
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

  it('does not let a failed revocation block the purge', async () => {
    mockRevoke.mockRejectedValueOnce(new Error('offline'));

    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));

    await act(async () => {
      screen.getByTestId('signout').props.onPress();
    });

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
