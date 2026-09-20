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

import * as AuthSession from 'expo-auth-session';
import { useCallback, useMemo } from 'react';

import { getOidcClientConfig } from './oidcConfig';
import {
  buildAuthRequestConfig,
  exchangeAuthorizationCode,
  extractAuthorizationCode,
  useAuthRequest,
  useAutoDiscovery,
  type OidcTokens,
} from './oidcSession';

/**
 * The options handed to `makeRedirectUri`, and therefore the URI the
 * authorization endpoint sends the patient back to.
 *
 * **`path` must match the filename of a route in `app/`** — `redirect`
 * here means `app/redirect.tsx` has to exist. Android delivers the
 * redirect to the app as an ordinary deep link as well as resolving
 * `promptAsync()`, so Expo Router routes on it: with no such file, a
 * patient whose sign-in fully succeeded lands on "Unmatched Route"
 * holding a live session (R.S1). Rename one without the other and
 * sign-in appears to break again.
 *
 * Exported so the invariant that matters — a scheme AND a non-empty path —
 * is assertable directly, the way `oidcSession.ts` keeps the plain
 * testable pieces out of the hook.
 */
export const REDIRECT_URI_OPTIONS = { scheme: 'ostomydiary', path: 'redirect' } as const;

/**
 * The one hook `app/login.tsx` calls to run the full Authorization
 * Code + PKCE flow against the patient OIDC provider (`useAuthRequest`/
 * `useAutoDiscovery` are React hooks and cannot live in a plain function —
 * see `./oidcSession.ts` for the plain, unit-testable pieces this
 * composes).
 */
export function useOidcLogin(): {
  readonly isReady: boolean;
  readonly login: () => Promise<OidcTokens | undefined>;
} {
  const config = useMemo(() => getOidcClientConfig(), []);
  const discovery = useAutoDiscovery(config.issuer);
  // `scheme` and `path` are both explicit, and the path is what matters.
  //
  // `makeRedirectUri()` with no arguments returns the bare scheme —
  // `ostomydiary://`, with no authority and no path. That is not a legal
  // absolute URI, and the authorization endpoint refuses the request
  // before any user interaction: mock-oauth2-server answers
  // `invalid_request` / "illegal redirect_uri parameter" (Nimbus
  // `ParseException`), so sign-in could never complete against the
  // development stack. Found by the Gate B walkthrough (R.S1); the unit
  // tests around it had always used `ostomydiary://redirect` as their
  // fixture, so they asserted a value this function never produced.
  //
  // Passing `scheme` explicitly also pins the dev-build case, where
  // `makeRedirectUri` would otherwise derive an `exp+...` development-client
  // URL that no OIDC provider has been registered with.
  const redirectUri = useMemo(() => AuthSession.makeRedirectUri(REDIRECT_URI_OPTIONS), []);
  const requestConfig = useMemo(
    () => buildAuthRequestConfig(config, redirectUri),
    [config, redirectUri],
  );
  const [request, response, promptAsync] = useAuthRequest(requestConfig, discovery);

  const login = useCallback(async (): Promise<OidcTokens | undefined> => {
    if (!request || !discovery) return undefined;
    const result = await promptAsync();
    const authorization = extractAuthorizationCode(request, result ?? response);
    if (!authorization) return undefined;
    return exchangeAuthorizationCode(discovery, config, authorization);
  }, [request, discovery, promptAsync, response, config]);

  return { isReady: request !== null && discovery !== null, login };
}
