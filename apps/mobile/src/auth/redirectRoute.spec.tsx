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
 * The redirect route, which since ADR-0021 is what completes sign-in.
 *
 * ## Why this file had to exist
 *
 * #72 shipped because every auth spec in this app mocks `promptAsync` and
 * therefore asserts what the app does **with** a successful authorization —
 * while on Android that success never arrived. `useOidcLogin.spec.ts` asserts
 * only `REDIRECT_URI_OPTIONS`; `AuthContext.spec.tsx` mocks `oidcSession`
 * wholesale. Neither could see that the code was reaching the app by a path
 * nothing exchanged.
 *
 * A device walkthrough proves the handoff works once, on one build. This is
 * what stops it regressing, on the path that is now load-bearing.
 *
 * ## Why this file is in `src/auth/` and not beside the route it tests
 *
 * `app/` is Expo Router's route directory, enumerated with `require.context` —
 * so **every** file there becomes a route and is pulled into the app bundle. A
 * spec placed next to `app/redirect.tsx` made Metro bundle
 * `@testing-library/react-native` into the application, and the bundle stopped
 * loading on the device entirely, with a `.expo/.virtual-metro-entry` failure
 * that names neither the file nor the reason.
 *
 * Every other mobile spec already lives under `src/`, which is why nothing had
 * hit this before. Keep it that way: a test for a route belongs here, importing
 * the route by path.
 */

import { render, waitFor } from '@testing-library/react-native';

const mockCompleteLogin = jest.fn();
const mockReportSignInFailure = jest.fn();
const mockGetPending = jest.fn();
const mockClearPending = jest.fn();
const mockExchange = jest.fn();
let mockParams: Record<string, string | string[] | undefined> = {};

jest.mock('expo-router', () => ({
  // The real `Redirect` would need a router context; the assertions here are
  // about what the route DOES, not where it sends the patient afterwards.
  Redirect: () => null,
  useLocalSearchParams: () => mockParams,
}));

jest.mock('./AuthContext', () => ({
  useAuth: () => ({
    completeLogin: mockCompleteLogin,
    reportSignInFailure: mockReportSignInFailure,
  }),
}));

jest.mock('./oidcConfig', () => ({
  getOidcClientConfig: () => ({
    issuer: 'http://localhost:8090/patient-issuer',
    clientId: 'ostomy-patient-app',
    scopes: ['openid'],
  }),
}));

jest.mock('./pendingAuthRequest', () => ({
  getPendingAuthRequest: () => mockGetPending(),
  clearPendingAuthRequest: () => mockClearPending(),
}));

/**
 * `null` is the state that broke this route on a device: `useAutoDiscovery` is an
 * async fetch, so the first render always sees `null`, and the route used to
 * unmount before it resolved. Made switchable here so the bounded wait has
 * coverage.
 */
let mockDiscovery: object | null = { tokenEndpoint: 'http://localhost:8090/patient-issuer/token' };

jest.mock('./oidcSession', () => {
  const actual = jest.requireActual('./oidcSession');
  return {
    // The real one: the state check is the thing under test, not a mock's
    // idea of it.
    readAuthorizationCallback: actual.readAuthorizationCallback,
    exchangeAuthorizationCode: (...args: unknown[]) => mockExchange(...args),
    useAutoDiscovery: () => mockDiscovery,
  };
});

import OidcRedirect from '../../app/redirect';

const PENDING = {
  codeVerifier: 'verifier-abc',
  state: 'state-xyz',
  redirectUri: 'ostomydiary://redirect',
};

const TOKENS = { accessToken: 'at', refreshToken: 'rt', idToken: 'it' };

/**
 * Fake timers, because the route schedules a **20-second** real timer on every
 * mount to bound its wait for the discovery document.
 *
 * With real timers this suite left ten of those pending and the first test
 * exceeded jest's 5s limit on CI while passing locally — a test that is green
 * only on the faster machine is not a guard. Fake timers also make the timeout
 * branch testable at all, rather than only observable by waiting.
 */
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockDiscovery = { tokenEndpoint: 'http://localhost:8090/patient-issuer/token' };
  mockParams = {};
  mockGetPending.mockResolvedValue(PENDING);
  mockClearPending.mockResolvedValue(undefined);
  mockExchange.mockResolvedValue(TOKENS);
  mockCompleteLogin.mockResolvedValue(undefined);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('the OIDC redirect route', () => {
  it('exchanges the code from the deep link and completes the login', async () => {
    mockParams = { code: 'the-code', state: 'state-xyz' };

    await render(<OidcRedirect />);

    await waitFor(() => expect(mockCompleteLogin).toHaveBeenCalledWith(TOKENS));
    // The persisted verifier and the persisted redirect URI, not values this
    // route re-derived.
    expect(mockExchange).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      code: 'the-code',
      codeVerifier: 'verifier-abc',
      redirectUri: 'ostomydiary://redirect',
    });
    expect(mockReportSignInFailure).not.toHaveBeenCalled();
  });

  /**
   * The CSRF refusal, asserted at the route rather than only at the pure
   * function: what matters is that a mismatch reaches no token endpoint AND is
   * reported, not merely that a helper returned the right enum member.
   */
  it('refuses a state mismatch without exchanging anything, and reports it', async () => {
    mockParams = { code: 'the-code', state: 'forged' };

    await render(<OidcRedirect />);

    await waitFor(() => expect(mockReportSignInFailure).toHaveBeenCalled());
    expect(mockExchange).not.toHaveBeenCalled();
    expect(mockCompleteLogin).not.toHaveBeenCalled();
  });

  it('reports a provider error carried in the redirect', async () => {
    mockParams = { error: 'access_denied', state: 'state-xyz' };

    await render(<OidcRedirect />);

    await waitFor(() => expect(mockReportSignInFailure).toHaveBeenCalled());
    expect(mockExchange).not.toHaveBeenCalled();
  });

  it('reports a failed token exchange', async () => {
    mockParams = { code: 'the-code', state: 'state-xyz' };
    mockExchange.mockRejectedValue(new Error('token endpoint said no'));

    await render(<OidcRedirect />);

    await waitFor(() => expect(mockReportSignInFailure).toHaveBeenCalled());
    expect(mockCompleteLogin).not.toHaveBeenCalled();
  });

  /**
   * Reached without a code — a stray deep link, or a warm start onto this path.
   * Nothing was attempted, so reporting a failed sign-in would be a lie that
   * puts an error in front of a patient who did nothing wrong.
   */
  it('reports nothing when the route is reached without a code', async () => {
    mockParams = {};

    await render(<OidcRedirect />);

    await waitFor(() => expect(mockClearPending).toHaveBeenCalled());
    expect(mockReportSignInFailure).not.toHaveBeenCalled();
    expect(mockExchange).not.toHaveBeenCalled();
  });

  /**
   * The verifier is a secret held for one round trip. Left behind it is kept
   * for no reason, and a later redirect carrying a stale `state` would be
   * checked against a request nobody is waiting on.
   */
  describe('the pending request is always cleared', () => {
    it('clears it after a successful exchange', async () => {
      mockParams = { code: 'the-code', state: 'state-xyz' };

      await render(<OidcRedirect />);

      await waitFor(() => expect(mockClearPending).toHaveBeenCalled());
    });

    it('clears it after a refused state', async () => {
      mockParams = { code: 'the-code', state: 'forged' };

      await render(<OidcRedirect />);

      await waitFor(() => expect(mockClearPending).toHaveBeenCalled());
    });

    it('clears it after a failed exchange', async () => {
      mockParams = { code: 'the-code', state: 'state-xyz' };
      mockExchange.mockRejectedValue(new Error('nope'));

      await render(<OidcRedirect />);

      await waitFor(() => expect(mockClearPending).toHaveBeenCalled());
    });
  });

  /**
   * An authorization code is single-use. A second attempt would be refused by
   * the token endpoint, and that refusal would be reported as a failed sign-in
   * for a session that had in fact been established — the worst of both.
   */
  it('exchanges once even when the route re-renders', async () => {
    mockParams = { code: 'the-code', state: 'state-xyz' };

    const view = await render(<OidcRedirect />);
    await waitFor(() => expect(mockCompleteLogin).toHaveBeenCalled());
    await view.rerender(<OidcRedirect />);
    await view.rerender(<OidcRedirect />);

    expect(mockExchange).toHaveBeenCalledTimes(1);
  });

  /**
   * The bug the device found, which every mocked test had been blind to: the
   * route must NOT navigate away before discovery resolves.
   *
   * Here discovery is `null` at mount — as it is on every real run — and the
   * route must still exchange once it arrives, rather than having unmounted.
   */
  it('still exchanges when discovery resolves after the first render', async () => {
    mockParams = { code: 'the-code', state: 'state-xyz' };
    mockDiscovery = null;

    const view = await render(<OidcRedirect />);
    expect(mockExchange).not.toHaveBeenCalled();

    mockDiscovery = { tokenEndpoint: 'http://localhost:8090/patient-issuer/token' };
    await view.rerender(<OidcRedirect />);

    await waitFor(() => expect(mockCompleteLogin).toHaveBeenCalledWith(TOKENS));
  });

  /**
   * The bound on that wait. Without it a patient whose network dropped between
   * authorizing and returning would sit on "Finishing sign in" forever — the
   * dismissal signal that covers a closed browser lives on the login screen,
   * which is unmounted by the time this route runs.
   */
  it('reports a failure when discovery never resolves', async () => {
    mockParams = { code: 'the-code', state: 'state-xyz' };
    mockDiscovery = null;

    await render(<OidcRedirect />);
    expect(mockReportSignInFailure).not.toHaveBeenCalled();

    jest.advanceTimersByTime(20_000);

    await waitFor(() => expect(mockReportSignInFailure).toHaveBeenCalled());
    expect(mockExchange).not.toHaveBeenCalled();
  });

  /**
   * No pending request means either nothing started one, or a previous outcome
   * already consumed it. Exchanging anyway would send a code with no verifier.
   */
  it('refuses a code when no request is pending', async () => {
    mockParams = { code: 'the-code', state: 'state-xyz' };
    mockGetPending.mockResolvedValue(undefined);

    await render(<OidcRedirect />);

    await waitFor(() => expect(mockReportSignInFailure).toHaveBeenCalled());
    expect(mockExchange).not.toHaveBeenCalled();
  });
});
