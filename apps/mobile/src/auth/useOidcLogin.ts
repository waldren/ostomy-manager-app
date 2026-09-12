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
  const redirectUri = useMemo(() => AuthSession.makeRedirectUri(), []);
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
