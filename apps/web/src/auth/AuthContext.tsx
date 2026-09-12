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

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { fetchDiscoveryDocument } from './discovery.js';
import { loadOidcConfig } from './oidc-config.js';
import {
  generateCodeChallenge,
  generateCodeVerifier,
  generateRandomUrlSafeString,
} from './pkce.js';
import {
  clearPkceState,
  clearTokens,
  loadPkceState,
  loadTokens,
  savePkceState,
  saveTokens,
  type StoredTokens,
} from './session-storage.js';
import { exchangeAuthorizationCode, refreshAccessToken } from './token-client.js';

export type AuthStatus = 'initializing' | 'authenticated' | 'unauthenticated';

export interface AuthContextValue {
  readonly status: AuthStatus;
  /** Set only when sign-in itself failed (a rejected callback, a failed exchange) — not a routing decision. */
  readonly error: string | undefined;
  readonly signIn: () => Promise<void>;
  /** `reason` is an error key set when the session ended on its own — see the implementation. Callers signing the user out on purpose pass nothing. */
  readonly signOut: (reason?: string) => void;
  /** Passed directly to `createApiClient`'s `getAccessToken` option. Refreshes ahead of expiry when a refresh token is available. */
  readonly getAccessToken: () => Promise<string | undefined>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Refresh this far ahead of the token's stated expiry, to absorb request latency. */
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

/**
 * Fails **closed**: a non-finite `expiresAt` counts as expired.
 *
 * `expires_in` is RECOMMENDED, not REQUIRED, by RFC 6749 §5.1, and the token
 * response was cast straight from JSON. When it was absent, `expiresAt`
 * became `NaN` — and every comparison against `NaN` is `false`, so this
 * returned "not expired" **forever**. The app would never refresh, keep
 * sending a dead token, and 401 on every request with no path to recovery.
 * A stored `{}` left over from an earlier schema behaved identically.
 */
function isExpired(tokens: StoredTokens): boolean {
  if (!Number.isFinite(tokens.expiresAt)) {
    return true;
  }
  return Date.now() >= tokens.expiresAt - EXPIRY_SAFETY_MARGIN_MS;
}

/** Conservative lifetime when an issuer omits `expires_in`. Short on purpose: a wrong-and-short guess costs one refresh, a wrong-and-long one costs a broken session. */
const FALLBACK_TOKEN_LIFETIME_SECONDS = 300;

function toStoredTokens(response: {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}): StoredTokens {
  if (typeof response.access_token !== 'string' || response.access_token.length === 0) {
    throw new Error('Token response contained no access token.');
  }
  // Validated at the boundary rather than trusted: this is the one place an
  // issuer's JSON becomes application state, and the failure mode of a bad
  // value here is silent and permanent (see `isExpired`).
  const lifetimeSeconds =
    typeof response.expires_in === 'number' && Number.isFinite(response.expires_in)
      ? response.expires_in
      : FALLBACK_TOKEN_LIFETIME_SECONDS;

  return {
    accessToken: response.access_token,
    expiresAt: Date.now() + lifetimeSeconds * 1000,
    ...(response.refresh_token ? { refreshToken: response.refresh_token } : {}),
  };
}

/** Strips `code`/`state`/`error` query parameters from the visible URL after the callback is handled, so a page refresh never re-submits a spent authorization code. */
function clearAuthQueryParams(): void {
  const url = new URL(window.location.href);
  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  window.history.replaceState({}, '', url.toString());
}

export function AuthProvider({ children }: { readonly children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('initializing');
  const [error, setError] = useState<string | undefined>(undefined);
  /**
   * Tokens live in a ref, not state, and that is deliberate.
   *
   * `getAccessToken`'s identity must not change when tokens change — see its
   * doc comment — and nothing renders from the token values themselves;
   * `status` is what drives the UI. Holding them in state would mean either
   * an unstable callback (the refetch-loop defect) or a state variable no
   * one reads. `signOutRef` does the same for `signOut`, which is declared
   * after the callback that needs it.
   */
  const tokensRef = useRef<StoredTokens | undefined>(undefined);
  const signOutRef = useRef<(reason?: string) => void>(() => undefined);
  /** The in-flight refresh, shared by concurrent callers. See `getAccessToken`. */
  const refreshInFlight = useRef<Promise<string | undefined> | undefined>(undefined);
  // StrictMode/dev double-invokes effects; the authorization code is single-use,
  // so the callback must be handled at most once per code.
  const handledCallback = useRef(false);

  useEffect(() => {
    if (handledCallback.current) {
      return;
    }
    handledCallback.current = true;

    async function initialize() {
      const config = loadOidcConfig();
      const url = new URL(window.location.href);
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const oauthError = url.searchParams.get('error');

      if (oauthError) {
        clearAuthQueryParams();
        setError(oauthError);
        setStatus('unauthenticated');
        return;
      }

      if (code && returnedState) {
        const pending = loadPkceState();
        clearAuthQueryParams();
        if (!pending || pending.state !== returnedState) {
          setError('auth-state-mismatch');
          setStatus('unauthenticated');
          return;
        }
        try {
          const discovery = await fetchDiscoveryDocument(config.issuer);
          const response = await exchangeAuthorizationCode({
            tokenEndpoint: discovery.token_endpoint,
            clientId: config.clientId,
            audience: config.audience,
            code,
            redirectUri: config.redirectUri,
            codeVerifier: pending.codeVerifier,
          });
          clearPkceState();
          const next = toStoredTokens(response);
          saveTokens(next);
          tokensRef.current = next;
          setStatus('authenticated');
        } catch {
          setError('auth-exchange-failed');
          setStatus('unauthenticated');
        }
        return;
      }

      const existing = loadTokens();
      if (existing && !isExpired(existing)) {
        tokensRef.current = existing;
        setStatus('authenticated');
        return;
      }

      if (existing?.refreshToken) {
        try {
          const discovery = await fetchDiscoveryDocument(config.issuer);
          const response = await refreshAccessToken({
            tokenEndpoint: discovery.token_endpoint,
            clientId: config.clientId,
            audience: config.audience,
            refreshToken: existing.refreshToken,
          });
          const next = toStoredTokens(response);
          saveTokens(next);
          tokensRef.current = next;
          setStatus('authenticated');
          return;
        } catch {
          clearTokens();
        }
      }

      setStatus('unauthenticated');
    }

    // Any throw leaves the app usable rather than stuck.
    //
    // `initialize()` was invoked bare, and three synchronous throws are
    // reachable: `loadOidcConfig()` when any VITE_OIDC_* is unset (the state
    // of a fresh `.env.local`), and the two `JSON.parse` calls behind
    // `loadPkceState`/`loadTokens` on any malformed stored value — a
    // truncated write, a schema change between deploys, another app on the
    // same origin. The promise rejected unhandled, `status` stayed
    // `'initializing'`, and `RequireAuth` rendered "Signing you in…"
    // permanently. There is no error boundary, so nothing was rendered that
    // could tell the user to clear site data.
    void initialize().catch((cause: unknown) => {
      setError(cause instanceof Error ? cause.message : 'initialization_failed');
      setStatus('unauthenticated');
    });
  }, []);

  const signIn = useCallback(async () => {
    const config = loadOidcConfig();
    const discovery = await fetchDiscoveryDocument(config.issuer);
    const codeVerifier = generateCodeVerifier();
    const state = generateRandomUrlSafeString();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    savePkceState({ codeVerifier, state });

    const authorizeUrl = new URL(discovery.authorization_endpoint);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', config.clientId);
    authorizeUrl.searchParams.set('redirect_uri', config.redirectUri);
    // Both from configuration, never hardcoded — see `OidcConfig.audience`
    // and `.scope`. Without `audience` the issuer mints a default-audience
    // token and every API call 401s; `offline_access` was hardcoded here and
    // is rejected outright by Cognito.
    authorizeUrl.searchParams.set('scope', config.scope);
    authorizeUrl.searchParams.set('audience', config.audience);
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    window.location.assign(authorizeUrl.toString());
  }, []);

  /**
   * `reason` is set when the session ended on its own rather than by the
   * user asking. An expired or rejected refresh token dropped the clinician
   * to the login page with no explanation at all, which reads as the app
   * having logged them out at random; the catalog already carried
   * `auth.sessionExpired` for exactly this and nothing used it.
   */
  const signOut = useCallback((reason?: string) => {
    clearTokens();
    clearPkceState();
    tokensRef.current = undefined;
    setError(reason);
    setStatus('unauthenticated');
  }, []);

  /**
   * Identity-stable, and single-flight on refresh.
   *
   * Two defects fixed here, both consequences of closing over `tokens`:
   *
   * 1. **The identity changed on every refresh.** `PhysicianOutputView`
   *    memoizes its API client on this function, and its load effect depends
   *    on that client — so a token refresh re-created the client and re-fired
   *    the data fetch. With a clock skewed past the token lifetime, or an
   *    issuer sending a very short `expires_in`, that becomes an unbounded
   *    loop: every call takes the refresh branch, which changes the identity,
   *    which re-runs the effect, which calls again. `apps/api` sets
   *    `OIDC_CLOCK_TOLERANCE_SECONDS=30` precisely because skew is expected.
   *
   * 2. **Parallel callers each started their own refresh.** With any issuer
   *    that rotates refresh tokens, the second exchange returns
   *    `invalid_grant`, the catch calls `signOut()`, and the clinician is
   *    bounced to the login page mid-session with their page state gone.
   *    Nothing fires two parallel requests *today* — but SRS §3.5 requires
   *    more signals on this view, and the second one added would have found
   *    this the hard way.
   *
   * The ref mirrors the state so the callback can read current tokens with an
   * empty dependency list; the state still drives rendering.
   */
  const getAccessToken = useCallback(async (): Promise<string | undefined> => {
    const current = tokensRef.current;
    if (!current) {
      return undefined;
    }
    if (!isExpired(current)) {
      return current.accessToken;
    }
    if (!current.refreshToken) {
      signOutRef.current('session_expired');
      return undefined;
    }
    // Join the in-flight refresh rather than starting a second one.
    if (refreshInFlight.current) {
      return refreshInFlight.current;
    }

    const refresh = (async () => {
      try {
        const config = loadOidcConfig();
        const discovery = await fetchDiscoveryDocument(config.issuer);
        const response = await refreshAccessToken({
          tokenEndpoint: discovery.token_endpoint,
          clientId: config.clientId,
          audience: config.audience,
          refreshToken: current.refreshToken as string,
        });
        const next = toStoredTokens(response);
        saveTokens(next);
        tokensRef.current = next;
        return next.accessToken;
      } catch {
        signOutRef.current('session_expired');
        return undefined;
      } finally {
        refreshInFlight.current = undefined;
      }
    })();

    refreshInFlight.current = refresh;
    return refresh;
  }, []);

  // Kept current so `getAccessToken` can call it without depending on it.
  signOutRef.current = signOut;

  const value = useMemo<AuthContextValue>(
    () => ({ status, error, signIn, signOut, getAccessToken }),
    [status, error, signIn, signOut, getAccessToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth() must be called within an <AuthProvider>.');
  }
  return context;
}
