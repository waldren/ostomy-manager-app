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
  readonly signOut: () => void;
  /** Passed directly to `createApiClient`'s `getAccessToken` option. Refreshes ahead of expiry when a refresh token is available. */
  readonly getAccessToken: () => Promise<string | undefined>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

/** Refresh this far ahead of the token's stated expiry, to absorb request latency. */
const EXPIRY_SAFETY_MARGIN_MS = 30_000;

function isExpired(tokens: StoredTokens): boolean {
  return Date.now() >= tokens.expiresAt - EXPIRY_SAFETY_MARGIN_MS;
}

function toStoredTokens(response: {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
}): StoredTokens {
  return {
    accessToken: response.access_token,
    expiresAt: Date.now() + response.expires_in * 1000,
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
  const [tokens, setTokens] = useState<StoredTokens | undefined>(undefined);
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
          setTokens(next);
          setStatus('authenticated');
        } catch {
          setError('auth-exchange-failed');
          setStatus('unauthenticated');
        }
        return;
      }

      const existing = loadTokens();
      if (existing && !isExpired(existing)) {
        setTokens(existing);
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
          setTokens(next);
          setStatus('authenticated');
          return;
        } catch {
          clearTokens();
        }
      }

      setStatus('unauthenticated');
    }

    void initialize();
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

  const signOut = useCallback(() => {
    clearTokens();
    clearPkceState();
    setTokens(undefined);
    setStatus('unauthenticated');
  }, []);

  const getAccessToken = useCallback(async (): Promise<string | undefined> => {
    if (!tokens) {
      return undefined;
    }
    if (!isExpired(tokens)) {
      return tokens.accessToken;
    }
    if (!tokens.refreshToken) {
      signOut();
      return undefined;
    }
    try {
      const config = loadOidcConfig();
      const discovery = await fetchDiscoveryDocument(config.issuer);
      const response = await refreshAccessToken({
        tokenEndpoint: discovery.token_endpoint,
        clientId: config.clientId,
        audience: config.audience,
        refreshToken: tokens.refreshToken,
      });
      const next = toStoredTokens(response);
      saveTokens(next);
      setTokens(next);
      return next.accessToken;
    } catch {
      signOut();
      return undefined;
    }
  }, [tokens, signOut]);

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
