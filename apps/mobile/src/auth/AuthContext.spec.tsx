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
import { useState } from 'react';
import { Text } from 'react-native';

import { AuthProvider, useAuth } from './AuthContext';

const mockHasStored = jest.fn(async () => true);
const mockGetRefresh = jest.fn(async () => 'rt' as string | null);
const mockClearRefresh = jest.fn(async () => undefined);
const mockSetRefresh = jest.fn(async (_token: string) => undefined);
const mockRecordReason = jest.fn(async (_reason: string) => undefined);
const mockReadReason = jest.fn(async () => null as string | null);
const mockClearReason = jest.fn(async () => undefined);

jest.mock('./tokenStorage', () => ({
  hasStoredRefreshToken: () => mockHasStored(),
  getRefreshToken: () => mockGetRefresh(),
  clearRefreshToken: () => mockClearRefresh(),
  setRefreshToken: (t: string) => mockSetRefresh(t),
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
// Typed with every field a real `OidcTokens` carries, so a test overriding the
// expiry is not rejected by the inferred shape of the default.
const mockRefresh = jest.fn(async () => ({
  accessToken: 'fresh',
  refreshToken: 'rt2' as string | undefined,
  expiresAtSeconds: undefined as number | undefined,
}));
jest.mock('./oidcSession', () => ({
  useAutoDiscovery: () => ({ tokenEndpoint: 'https://issuer.example/token' }),
  refreshAccessToken: () => mockRefresh(),
  revokeRefreshToken: () => mockRevoke(),
  // The REAL classifier, not a stand-in. What #40 turns on is whether an
  // `invalid_grant` is told apart from a network failure, so a re-implementation here
  // would assert only that this file agrees with itself — the same shape of mistake
  // #55 and #61 both recorded.
  isRefreshTokenRejected: jest.requireActual('./oidcSession').isRefreshTokenRejected,
  // Real, for the same reason: the whole point is whether an expiring token is
  // recognised as expiring, so a stand-in would assert only self-agreement.
  accessTokenNeedsRenewal: jest.requireActual('./oidcSession').accessTokenNeedsRenewal,
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
  const {
    phase,
    signOut,
    completeLogin,
    unlock,
    signedOutReason,
    accessToken,
    getFreshAccessToken,
  } = useAuth();
  const [fresh, setFresh] = useState<string | undefined>(undefined);
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
      <Text testID="token">{accessToken ?? 'none'}</Text>
      <Text testID="fresh">{fresh ?? 'unasked'}</Text>
      <Text
        testID="loginExpiring"
        onPress={() =>
          void completeLogin({
            accessToken: 'already-stale',
            refreshToken: 'rt',
            idToken: makeJwt({ sub: 'patient-a' }),
            // Already past. A real provider returns a short life here, and the point
            // is that a token from a fresh SIGN-IN carries an expiry too — not only
            // one from a refresh.
            expiresAtSeconds: Math.floor(Date.now() / 1000) - 1,
          })
        }
      >
        log in with an expiring token
      </Text>
      <Text
        testID="askFresh"
        onPress={() => {
          void getFreshAccessToken().then((value) => setFresh(value ?? 'none'));
        }}
      >
        ask
      </Text>
      <Text
        testID="askFreshTwice"
        onPress={() => {
          // Both started before either resolves, which is what the single-flight
          // guard is for.
          void Promise.all([getFreshAccessToken(), getFreshAccessToken()]);
        }}
      >
        ask twice
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
  mockAuthenticate.mockResolvedValue({ outcome: 'success' });
  mockReadReason.mockResolvedValue(null);
  // No expiry by default: the provider is allowed to omit `expires_in`, and that
  // means "does not expire" rather than "expired" — so the default keeps every test
  // that is not about expiry out of the renewal path.
  mockRefresh.mockResolvedValue({
    accessToken: 'fresh',
    refreshToken: 'rt2',
    expiresAtSeconds: undefined,
  });
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

/**
 * A reason left over from an automatic sign-out must not survive to explain a
 * DELIBERATE one. A patient who simply signed out would otherwise be told "The
 * fingerprint, face, or screen lock on this phone changed" — false and alarming.
 */
describe('signing out clears any recorded reason', () => {
  it('clears it, so the next login screen is not falsely explained', async () => {
    mockReadReason.mockResolvedValue('unlock-settings-changed');

    await renderProvider();
    await act(async () => {
      screen.getByTestId('signout').props.onPress();
    });

    expect(mockClearReason).toHaveBeenCalled();
    expect(screen.getByTestId('reason')).toHaveTextContent('none');
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
  /**
   * The inverse of the two tests that were here (ADR-0015 Amendment 2, #116).
   *
   * They asserted that an enrolment appearing while the process was alive purged
   * the session mid-unlock. That window mattered while biometric was the only
   * authenticator the gate accepted, because enrolling one was then a privilege
   * escalation. It is not one now: enrolling on Android requires the device
   * credential, which unlocks this app.
   */
  it('unlocks normally when a biometric was enrolled while the app was running', async () => {
    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));

    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });

    expect(screen.getByTestId('phase')).toHaveTextContent('authenticated');
    expect(mockClearRefresh).not.toHaveBeenCalled();
    expect(mockRecordReason).not.toHaveBeenCalled();
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

  /**
   * A token read that THROWS is not a token that is gone, and conflating them put
   * #40 straight back: a rejection is not an `invalid_grant`, so it fell through to
   * the silent swallow and left the app `authenticated` holding no access token.
   *
   * Reachable from a cancelled OS sheet on a gated read, a locked-out sensor, and
   * possibly an invalidated key — whether that surfaces as `null` or a rejection is
   * unverified, so this path has to be right either way.
   *
   * It now STAYS UNLOCKED (#116). This used to re-lock, which is what made the
   * defect present as a button that silently does nothing: the patient
   * authenticated, the gated read raised a prompt they could not satisfy, and they
   * were returned to the lock screen with no message. Pressing Unlock repeated it
   * forever.
   *
   * ADR-0014 leaves the SQLCipher key ungated, so the diary never needed this
   * token — only sync does. Re-locking withheld data that was not behind the
   * credential at all. The file's own comment above the call already said a failure
   * here "never reverts the phase transition"; now the code agrees with it.
   */
  it('stays unlocked, rather than re-locking, when the token read throws', async () => {
    mockGetRefresh.mockRejectedValue(new Error('keychain unavailable'));

    await renderProvider();
    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });

    expect(screen.getByTestId('phase')).toHaveTextContent('authenticated');
    expect(mockClearRefresh).not.toHaveBeenCalled();
    expect(mockRecordReason).not.toHaveBeenCalled();
  });
});

/**
 * What cold start does now, and what it deliberately no longer does.
 *
 * Two tests here used to assert #74's enrolment-rise purge — that a stored token
 * was discarded and the patient routed to a network sign-in when
 * `getEnrolledLevelAsync()` had risen since it was written. ADR-0015 Amendment 2
 * removed that check, so a stored session simply routes to the lock screen.
 *
 * The signed-out-reason tests below are unrelated to the purge and are kept: the
 * issuer can still reject a refresh token, which still needs explaining.
 */
describe('cold start routes a stored session to the lock screen', () => {
  it('does not purge anything on the way', async () => {
    mockHasStored.mockResolvedValue(true);

    await renderProvider();

    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));
    expect(mockClearRefresh).not.toHaveBeenCalled();
    expect(mockRecordReason).not.toHaveBeenCalled();
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
});

/**
 * #40. A refresh the ISSUER rejected is not an unknown fate.
 *
 * Both outcomes arrive as a thrown error from `refreshAccessToken`, and the catch
 * swallowed them identically — so an expired or revoked refresh token left the app in
 * `authenticated` holding no access token. `SyncProvider` gates on exactly that
 * phase, so the worker then ran on a timer with no credential and was refused every
 * time, while every screen truthfully reported entries saved and nothing offered a
 * route back in. The patient's diary silently stopped syncing.
 */
describe('a refresh token the issuer rejects ends the session (#40)', () => {
  /** The shape `expo-auth-session` throws: `code` is the raw OAuth error. */
  function tokenError(error: string): Error {
    return Object.assign(new Error(error), { code: error, params: { error } });
  }

  async function unlockAfterRefreshFails(error: unknown): Promise<void> {
    mockRefresh.mockRejectedValue(error);
    await renderProvider();
    await waitFor(() => expect(screen.getByTestId('phase')).toHaveTextContent('locked'));
    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });
  }

  it('routes to sign-in rather than an authenticated session with no token', async () => {
    await unlockAfterRefreshFails(tokenError('invalid_grant'));

    expect(screen.getByTestId('phase')).toHaveTextContent('signedOut');
  });

  it('says why, so the patient does not meet a bare sign-in screen', async () => {
    await unlockAfterRefreshFails(tokenError('invalid_grant'));

    expect(mockRecordReason).toHaveBeenCalledWith('session-expired');
  });

  /**
   * Not `unlock-settings-changed`: that copy asserts something about the phone's
   * security which is false here, and would send the patient looking for a problem
   * that does not exist.
   */
  it("does not blame the phone's unlock settings", async () => {
    await unlockAfterRefreshFails(tokenError('invalid_grant'));

    expect(mockRecordReason).not.toHaveBeenCalledWith('unlock-settings-changed');
  });

  it('clears the token but never purges the database', async () => {
    // ADR-0014's asymmetry, and the thing that makes this safe to do at all: the
    // SQLCipher key carries no `requireAuthentication`, so the diary and anything
    // still queued survive. Purging would make an expired sign-in cost data.
    await unlockAfterRefreshFails(tokenError('invalid_grant'));

    expect(mockClearRefresh).toHaveBeenCalled();
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it('does not leave the access token in memory', async () => {
    // The context would otherwise hand a live bearer credential to any component
    // while `phase === 'signedOut'`, which contradicts what that phase means — the
    // mirror of the bug this whole change is about, a phase claiming less than the
    // session holds.
    //
    // Reached through a session that actually HOLDS a token. Asserting this on the
    // `invalid_grant` path alone passes vacuously: no token was ever set there,
    // because the refresh that would have set one is the thing that failed.
    await renderProvider();
    await act(async () => {
      screen.getByTestId('login').props.onPress();
    });
    expect(screen.getByTestId('token')).toHaveTextContent('opaque-access-token');

    // Now end the session from under it. The purge this used to trigger is gone
    // (ADR-0015 Amendment 2), so the session is ended the way it still can be: the
    // stored token is no longer there, which `renewAccessToken` reports as
    // `no-session` and `unlock()` turns into a real sign-out.
    mockGetRefresh.mockResolvedValue(null);
    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });

    expect(screen.getByTestId('phase')).toHaveTextContent('signedOut');
    expect(screen.getByTestId('token')).toHaveTextContent('none');
  });

  it('KEEPS the session when the provider is merely unreachable', async () => {
    // The counterpart, and the more important half. This app is used offline by
    // design, so signing a patient out of a diary they can still write in is the
    // worse of the two errors — and a rule that signed out on every failed refresh
    // would do it every time they unlocked without a network.
    await unlockAfterRefreshFails(new TypeError('Network request failed'));

    expect(screen.getByTestId('phase')).toHaveTextContent('authenticated');
    expect(mockClearRefresh).not.toHaveBeenCalled();
  });

  it('keeps the session for a transient server error too', async () => {
    await unlockAfterRefreshFails(tokenError('temporarily_unavailable'));

    expect(screen.getByTestId('phase')).toHaveTextContent('authenticated');
    expect(mockClearRefresh).not.toHaveBeenCalled();
  });
});

/**
 * The `expiresAtSeconds` gap. It was captured on every token and never consulted, so
 * a token simply lapsed: every request 401'd, the sync worker stopped with
 * `unauthenticated` — which schedules no retry — and nothing recovered until the
 * next lock and unlock. An access token lives for minutes and a session lives for
 * days, so this was the ordinary case.
 *
 * The check lives at the one place every API call passes through, so no call site
 * has to remember it.
 */
describe('the access token is refreshed before it is used, not after it fails', () => {
  const HOUR = 3600;

  function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
  }

  it('reuses a token that is still good, without touching the network', async () => {
    await renderProvider();
    await act(async () => {
      screen.getByTestId('login').props.onPress();
    });
    mockRefresh.mockClear();

    await act(async () => {
      screen.getByTestId('askFresh').props.onPress();
    });

    // The login handed over a token with no expiry, which means never-expiring.
    expect(screen.getByTestId('fresh')).toHaveTextContent('opaque-access-token');
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it('refreshes when the stored token is at or past expiry', async () => {
    // Unlock refreshes, and the refresh result carries the expiry.
    mockRefresh.mockResolvedValue({
      accessToken: 'stale',
      refreshToken: 'rt2',
      expiresAtSeconds: nowSeconds() - 1,
    });
    await renderProvider();
    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });
    expect(screen.getByTestId('token')).toHaveTextContent('stale');

    mockRefresh.mockResolvedValue({
      accessToken: 'renewed',
      refreshToken: 'rt3',
      expiresAtSeconds: nowSeconds() + HOUR,
    });
    await act(async () => {
      screen.getByTestId('askFresh').props.onPress();
    });

    expect(screen.getByTestId('fresh')).toHaveTextContent('renewed');
  });

  it('does not refresh again once the token is fresh', async () => {
    mockRefresh.mockResolvedValue({
      accessToken: 'good',
      refreshToken: 'rt2',
      expiresAtSeconds: nowSeconds() + HOUR,
    });
    await renderProvider();
    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });
    mockRefresh.mockClear();

    await act(async () => {
      screen.getByTestId('askFresh').props.onPress();
    });

    expect(mockRefresh).not.toHaveBeenCalled();
  });

  /**
   * Single-flight, and it is a correctness requirement rather than an optimisation.
   * An issuer that ROTATES refresh tokens invalidates the superseded one, so the
   * second of two overlapping refreshes answers `invalid_grant` — which this app
   * treats as "the session is over" (#40). Concurrent refreshes would therefore sign
   * a patient out of a perfectly good session.
   */
  it('collapses concurrent requests into one refresh', async () => {
    mockRefresh.mockResolvedValue({
      accessToken: 'stale',
      refreshToken: 'rt2',
      expiresAtSeconds: nowSeconds() - 1,
    });
    await renderProvider();
    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });
    mockRefresh.mockClear();

    await act(async () => {
      screen.getByTestId('askFreshTwice').props.onPress();
    });

    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  /**
   * The expiry has to be recorded at SIGN-IN, not only at refresh. Without it the
   * token from a fresh login has no known expiry, the accessor treats it as
   * never-expiring, and the first lapse is a silent 401 again — the whole gap,
   * reintroduced for exactly the patients who just signed in.
   */
  it('knows the expiry of a token that came from signing in', async () => {
    await renderProvider();
    await act(async () => {
      screen.getByTestId('loginExpiring').props.onPress();
    });
    expect(screen.getByTestId('token')).toHaveTextContent('already-stale');

    mockRefresh.mockResolvedValue({
      accessToken: 'renewed-after-login',
      refreshToken: 'rt3',
      expiresAtSeconds: Math.floor(Date.now() / 1000) + 3600,
    });
    await act(async () => {
      screen.getByTestId('askFresh').props.onPress();
    });

    expect(screen.getByTestId('fresh')).toHaveTextContent('renewed-after-login');
  });

  it('answers undefined rather than a stale token when the provider is unreachable', async () => {
    mockRefresh.mockResolvedValue({
      accessToken: 'stale',
      refreshToken: 'rt2',
      expiresAtSeconds: nowSeconds() - 1,
    });
    await renderProvider();
    await act(async () => {
      screen.getByTestId('unlock').props.onPress();
    });

    // Offline now. Sending the lapsed token would take a 401 and park the worker on a
    // stop it schedules no retry for; sending nothing takes the same 401 without
    // pretending the credential was good.
    mockRefresh.mockRejectedValue(new TypeError('Network request failed'));
    await act(async () => {
      screen.getByTestId('askFresh').props.onPress();
    });

    expect(screen.getByTestId('fresh')).toHaveTextContent('none');
    // And the session survives it — this is unknown fate, not a dead token.
    expect(screen.getByTestId('phase')).toHaveTextContent('authenticated');
  });
});
