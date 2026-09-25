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
import { setPendingAuthRequest } from './pendingAuthRequest';
import { buildAuthRequestConfig, useAuthRequest, useAutoDiscovery } from './oidcSession';

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

/** What a launched sign-in can tell the login screen before the redirect lands. */
export type SignInLaunchOutcome =
  /** The browser is open, or has closed with the redirect already in flight. Completion is `app/redirect.tsx`'s. */
  | 'launched'
  /** The patient closed the browser without finishing, and no redirect is coming. */
  | 'dismissed'
  /** Discovery has not resolved, so no request could be built. */
  | 'unavailable';

/**
 * Starts the Authorization Code + PKCE flow. **It does not finish it**
 * (ADR-0021).
 *
 * `app/redirect.tsx` performs the exchange, from the code in the redirect's own
 * query string. This hook's job is to persist what that completer will need and
 * open the browser.
 *
 * ## Why this hook no longer returns tokens
 *
 * It used to await `promptAsync()` and exchange whatever code that resolved
 * with. On Android that promise does not report success: the redirect is
 * resolved by `MainActivity` (the only component owning the `ostomydiary`
 * BROWSABLE filter) and `launchMode="singleTask"` brings its task to the front,
 * tearing the Custom Tab down before `BrowserProxyActivity` — which is what
 * resolves `promptAsync()` — is ever the target. Sign-in could not complete at
 * all (#72), and the failure was invisible because the redirect's navigation
 * remounted the login screen and discarded the error it had just set.
 *
 * An authorization code is single-use, so having two completers would mean one
 * of them always failing against the token endpoint. There is one.
 *
 * ## `promptAsync()` is still awaited, for the one thing it is reliable about
 *
 * Whether the browser went away. If it closes and no redirect follows — the
 * patient pressed Back, or cancelled at the provider — nothing else would ever
 * resolve, and the screen would sit on a spinner forever. A `dismiss`/`cancel`
 * result is how that is detected. It is never read for a code.
 */
export function useOidcLogin(): {
  readonly isReady: boolean;
  readonly login: () => Promise<SignInLaunchOutcome>;
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
  // `response` is deliberately unused. It is `useAuthRequest`'s record of the
  // last result, and reading it here is how the old implementation tried to
  // recover a code that, on Android, never arrives that way (#72).
  const [request, , promptAsync] = useAuthRequest(requestConfig, discovery);

  const login = useCallback(async (): Promise<SignInLaunchOutcome> => {
    if (!request || !discovery) return 'unavailable';

    // Persisted BEFORE the browser opens, because the redirect can arrive at
    // any moment after it does — and on Android the app process may be
    // reclaimed while the browser is foregrounded, so `request` itself is not
    // guaranteed to still exist when the completer runs.
    //
    // `codeVerifier` is generated by `useAuthRequest` when `usePKCE` is on;
    // `state` likewise. Both are read off the request rather than regenerated,
    // so what is stored is what was actually sent.
    if (request.codeVerifier === undefined || request.state === undefined) {
      return 'unavailable';
    }
    await setPendingAuthRequest({
      codeVerifier: request.codeVerifier,
      state: request.state,
      // The exact URI the request carried. The token endpoint compares it byte
      // for byte, and re-deriving it in the completer would be a second copy
      // of `makeRedirectUri(REDIRECT_URI_OPTIONS)` free to drift from this one.
      redirectUri: request.redirectUri,
    });

    const result = await promptAsync();

    // Read for DISMISSAL ONLY — never for a code. See the hook's comment: a
    // `success` here is not something this flow can rely on on Android, but a
    // dismissal is the only signal that no redirect is coming.
    if (result?.type === 'dismiss' || result?.type === 'cancel') return 'dismissed';
    return 'launched';
  }, [request, discovery, promptAsync]);

  return { isReady: request !== null && discovery !== null, login };
}
