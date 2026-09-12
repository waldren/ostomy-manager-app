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
 * Code review's standing observation about this sprint was that every module
 * with real branching had no test at all, and that every defect it found
 * lived in that untested layer. This is the largest of them, and the one
 * whose failures are security failures rather than rendering ones: a
 * sign-out that does not sign out, a PKCE verifier that outlives its
 * exchange, a refresh that silently discards the refresh token.
 *
 * Each block below names the specific defect it is holding down.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from './AuthContext.js';
import { resetDiscoveryCacheForTests } from './discovery.js';

const ISSUER = 'https://issuer.example';
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  end_session_endpoint: `${ISSUER}/logout`,
};

/** Replaces `window.location`, whose `assign` jsdom does not implement. */
let assignMock: ReturnType<typeof vi.fn>;

function stubLocation(href: string): void {
  assignMock = vi.fn();
  const url = new URL(href);
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      href: url.toString(),
      origin: url.origin,
      search: url.search,
      assign: assignMock,
    },
  });
}

function stubEnv(overrides: Record<string, string> = {}): void {
  vi.stubEnv('VITE_OIDC_ISSUER', ISSUER);
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'ostomy-web');
  vi.stubEnv('VITE_OIDC_REDIRECT_URI', 'http://localhost:3000/');
  vi.stubEnv('VITE_OIDC_AUDIENCE', 'ostomy-patient-app');
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value);
  }
}

/** Mounts the provider and exposes the context through the DOM. */
function Probe() {
  const { status, error, signOut } = useAuth();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="error">{error ?? ''}</span>
      <button onClick={() => signOut()}>sign out</button>
    </div>
  );
}

function renderProvider() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

/** Routes discovery to the fixture and everything else to the caller's handler. */
function mockFetch(onToken: (body: URLSearchParams) => Response): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('.well-known')) {
        return jsonResponse(DISCOVERY);
      }
      return onToken(new URLSearchParams(String(init?.body ?? '')));
    }),
  );
}

beforeEach(() => {
  resetDiscoveryCacheForTests();
  sessionStorage.clear();
  stubEnv();
  stubLocation('http://localhost:3000/');
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => jsonResponse(DISCOVERY)),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sign-out ends the session at the issuer', () => {
  /**
   * The defect, stated as the disclosure it produces: sign-out was local
   * only. `sessionStorage` was cleared, but the issuer's session cookie
   * survived — so the next person at the same clinic workstation clicks
   * "Sign in", is silently re-authenticated with no credential prompt, and
   * lands on the previous clinician's patient. The app's own sign-out button
   * is what sets that up.
   */
  it('redirects to end_session_endpoint with the id_token_hint', async () => {
    sessionStorage.setItem(
      'ostomy.auth.tokens',
      JSON.stringify({
        accessToken: 'at',
        expiresAt: Date.now() + 600_000,
        idToken: 'the-id-token',
      }),
    );

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await userEvent.click(screen.getByRole('button', { name: 'sign out' }));

    await waitFor(() => expect(assignMock).toHaveBeenCalledTimes(1));
    const target = new URL(assignMock.mock.calls[0]?.[0] as string);
    expect(target.origin + target.pathname).toBe(`${ISSUER}/logout`);
    // Without the hint most issuers show a "do you want to sign out?"
    // interstitial rather than ending the session — the confirmation step a
    // clinician walking away from the desk will never complete.
    expect(target.searchParams.get('id_token_hint')).toBe('the-id-token');
    expect(target.searchParams.get('client_id')).toBe('ostomy-web');
    expect(target.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3000');
  });

  it('clears local tokens before the redirect, not after it', async () => {
    // Ordering is the whole point. Discovery can be unreachable, the issuer
    // can refuse an unregistered post-logout URI, the redirect can be
    // blocked — and none of that may leave a usable token in this browser.
    sessionStorage.setItem(
      'ostomy.auth.tokens',
      JSON.stringify({ accessToken: 'at', expiresAt: Date.now() + 600_000 }),
    );
    // Discovery fails, so the redirect never happens.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 500 })),
    );

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await userEvent.click(screen.getByRole('button', { name: 'sign out' }));

    expect(sessionStorage.getItem('ostomy.auth.tokens')).toBeNull();
    expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated');
    expect(assignMock).not.toHaveBeenCalled();
  });
});

describe('the PKCE verifier does not outlive its exchange', () => {
  /**
   * A verifier that survives a failed callback is a verifier waiting to be
   * paired with someone else's authorization code: the next callback to
   * arrive on this tab, including a forged one, finds a stored state to
   * match against. The CSRF defence the state parameter provides is only as
   * good as the window in which a stale value can be reused.
   */
  it('clears the stored state when the returned state does not match', async () => {
    sessionStorage.setItem(
      'ostomy.auth.pkce',
      JSON.stringify({ codeVerifier: 'verifier', state: 'expected' }),
    );
    stubLocation('http://localhost:3000/?code=abc&state=forged');

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('auth-state-mismatch'),
    );
    expect(sessionStorage.getItem('ostomy.auth.pkce')).toBeNull();
  });

  it('clears the stored state when the code exchange is rejected', async () => {
    sessionStorage.setItem(
      'ostomy.auth.pkce',
      JSON.stringify({ codeVerifier: 'verifier', state: 'expected' }),
    );
    stubLocation('http://localhost:3000/?code=abc&state=expected');
    mockFetch(() => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }));

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId('error')).toHaveTextContent('auth-exchange-failed'),
    );
    expect(sessionStorage.getItem('ostomy.auth.pkce')).toBeNull();
  });
});

describe('a refresh keeps what the response is allowed to omit', () => {
  /**
   * RFC 6749 §6: a refresh response MAY omit `refresh_token`, and the client
   * must keep using the one it holds. This dropped it — so against any
   * non-rotating issuer (Cognito included) the FIRST refresh erased the
   * refresh token, and the next expiry minutes later signed the clinician
   * out mid-session with no way back but a full sign-in.
   */
  it('carries the existing refresh and id tokens forward', async () => {
    sessionStorage.setItem(
      'ostomy.auth.tokens',
      JSON.stringify({
        accessToken: 'stale',
        // Already expired, so initialize takes the refresh branch.
        expiresAt: Date.now() - 1_000,
        refreshToken: 'the-refresh-token',
        idToken: 'the-id-token',
      }),
    );
    // A response omitting both, which is the common issuer behaviour.
    mockFetch(() =>
      jsonResponse({ access_token: 'fresh', token_type: 'Bearer', expires_in: 3600 }),
    );

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    const stored = JSON.parse(sessionStorage.getItem('ostomy.auth.tokens') ?? '{}');
    expect(stored.accessToken).toBe('fresh');
    expect(stored.refreshToken).toBe('the-refresh-token');
    // Losing this costs the id_token_hint that makes sign-out silent.
    expect(stored.idToken).toBe('the-id-token');
  });
});

describe('inactivity timeout', () => {
  /**
   * The access token's expiry is not this control: a token stays valid
   * regardless of who is at the keyboard, and the physician view is a screen
   * showing one named patient's stoma output. The ordinary case this guards
   * is a clinic workstation walked away from, not an attacker.
   */
  it('signs the user out after the configured idle period', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubEnv({ VITE_SESSION_IDLE_TIMEOUT_MINUTES: '15' });
    sessionStorage.setItem(
      'ostomy.auth.tokens',
      // Long-lived on purpose: the point is that a perfectly valid token is
      // not what keeps the session open.
      JSON.stringify({ accessToken: 'at', expiresAt: Date.now() + 86_400_000 }),
    );

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await act(async () => {
      vi.advanceTimersByTime(15 * 60_000 + 1_000);
    });

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
    expect(screen.getByTestId('error')).toHaveTextContent('session_idle');
    expect(sessionStorage.getItem('ostomy.auth.tokens')).toBeNull();
  });

  it('does not sign out a session that is still being used', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubEnv({ VITE_SESSION_IDLE_TIMEOUT_MINUTES: '15' });
    sessionStorage.setItem(
      'ostomy.auth.tokens',
      JSON.stringify({ accessToken: 'at', expiresAt: Date.now() + 86_400_000 }),
    );

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    // Ten minutes, a keypress, then ten more. Cumulative elapsed time is
    // past the timeout; idle time never is.
    await act(async () => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    await act(async () => {
      window.dispatchEvent(new Event('keydown'));
      vi.advanceTimersByTime(10 * 60_000);
    });

    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
  });

  it('honours 0 as "no timeout" rather than signing out immediately', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubEnv({ VITE_SESSION_IDLE_TIMEOUT_MINUTES: '0' });
    sessionStorage.setItem(
      'ostomy.auth.tokens',
      JSON.stringify({ accessToken: 'at', expiresAt: Date.now() + 86_400_000 }),
    );

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await act(async () => {
      vi.advanceTimersByTime(60 * 60_000);
    });

    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');
  });

  it('falls back to the default rather than 0 when the value is not a number', async () => {
    // A typo in the environment would otherwise become NaN, and a NaN delay
    // is coerced to 0 — signing the user out on every poll. Failing to the
    // default keeps the control working; only an explicit 0 disables it.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubEnv({ VITE_SESSION_IDLE_TIMEOUT_MINUTES: 'fifteen' });
    sessionStorage.setItem(
      'ostomy.auth.tokens',
      JSON.stringify({ accessToken: 'at', expiresAt: Date.now() + 86_400_000 }),
    );

    renderProvider();
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('authenticated'));

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(screen.getByTestId('status')).toHaveTextContent('authenticated');

    await act(async () => {
      vi.advanceTimersByTime(15 * 60_000);
    });
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('unauthenticated'));
  });
});

describe('the reason a session ended survives the logout redirect', () => {
  it('restores it from storage on the next load', async () => {
    // RP-initiated logout leaves the origin, so React state cannot carry the
    // reason. Without this a clinician lands back on the login page with no
    // explanation, which reads as the app logging them out at random.
    sessionStorage.setItem('ostomy.auth.signOutReason', 'session_idle');

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('session_idle'));
    // Consumed, so it is shown once rather than on every later load.
    expect(sessionStorage.getItem('ostomy.auth.signOutReason')).toBeNull();
  });
});
