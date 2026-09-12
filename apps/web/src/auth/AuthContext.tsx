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
import { IdleWarningDialog } from './IdleWarningDialog.js';
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
  saveSignOutReason,
  saveTokens,
  takeSignOutReason,
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

/**
 * How long before the idle deadline the warning appears.
 *
 * WCAG 2.2.1 requires at least 20 seconds to extend; 60 gives a reader time
 * to notice the dialog, read it, and reach the button with a switch device.
 */
const IDLE_WARNING_LEAD_MS = 60_000;

/** Fine enough that the warning gets its full lead time and sign-out is punctual. */
const IDLE_POLL_INTERVAL_MS = 5_000;

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

/**
 * `previous` carries forward what a refresh response is allowed to omit.
 *
 * RFC 6749 §6: a refresh response MAY omit `refresh_token`, and the client
 * is then required to keep using the one it has. This dropped it instead, so
 * against any non-rotating issuer — Cognito included — the FIRST refresh
 * erased the refresh token, and the next expiry (minutes later) signed the
 * clinician out mid-session with no way back but a full sign-in. `id_token`
 * is the same story: it is issued at the authorization-code exchange and
 * usually absent from refresh responses, and losing it costs the
 * `id_token_hint` that makes RP-initiated logout end the session silently.
 */
function toStoredTokens(
  response: {
    access_token: string;
    expires_in?: number;
    refresh_token?: string;
    id_token?: string;
  },
  previous?: StoredTokens,
): StoredTokens {
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

  const refreshToken = response.refresh_token ?? previous?.refreshToken;
  const idToken = response.id_token ?? previous?.idToken;

  return {
    accessToken: response.access_token,
    expiresAt: Date.now() + lifetimeSeconds * 1000,
    ...(refreshToken ? { refreshToken } : {}),
    ...(idToken ? { idToken } : {}),
  };
}

/** Strips `code`/`state`/`error` query parameters from the visible URL after the callback is handled, so a page refresh never re-submits a spent authorization code. */
function clearAuthQueryParams(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('code');
    url.searchParams.delete('state');
    url.searchParams.delete('error');
    url.searchParams.delete('error_description');
    window.history.replaceState({}, '', url.toString());
  } catch {
    // Tidying the address bar is cosmetic; the callback handling around it
    // is not. `replaceState` throws a SecurityError whenever the computed
    // URL is not same-origin with the document, and this runs between
    // reading the PKCE state and clearing it — so an unhandled throw here
    // skipped `clearPkceState`, left the verifier in storage, and replaced
    // the specific auth error with a generic initialization failure.
    // Leaving a spent code in the visible URL is the lesser outcome; it is
    // single-use and the exchange has already been attempted.
  }
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
  /**
   * Bumped on every sign-out. Anything that was in flight across one compares
   * its captured value and discards its result.
   *
   * The defect this closes: `signOut` cleared tokens synchronously, but a
   * refresh already awaiting the token endpoint resumed afterwards and ran
   * `saveTokens(next)` — writing a brand-new VALID token set back into the
   * storage sign-out had just emptied. The next load found it unexpired and
   * restored the session, putting the previous clinician's record back on
   * screen for whoever was at the workstation next.
   *
   * The window is one HTTP round trip, and it is widest in precisely the
   * degraded paths this file already handles: when the issuer advertises no
   * `end_session_endpoint`, or discovery fails, nothing navigates away, so
   * the late write reliably lands and the document survives to use it.
   */
  const sessionEpoch = useRef(0);
  /** Last deliberate interaction. A ref, so the poll reads it without re-arming the effect. */
  const lastActivityAt = useRef(Date.now());
  const [idleWarningVisible, setIdleWarningVisible] = useState(false);
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
          // Clear it. A verifier that survives a mismatch is a verifier
          // waiting to be paired with someone else's authorization code:
          // the next callback to arrive on this tab — including a forged
          // one — finds a stored state to match against, and the CSRF
          // defence PKCE state exists to provide is only as good as the
          // window in which a stale value can be reused.
          clearPkceState();
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
          // A successful sign-in ends any prior session's story. Left in
          // place, a reason stranded by a local-only sign-out would surface
          // on a later reload of this new, healthy session.
          takeSignOutReason();
          const next = toStoredTokens(response);
          saveTokens(next);
          tokensRef.current = next;
          setStatus('authenticated');
        } catch {
          // Same reasoning as the mismatch branch above, plus: the code this
          // verifier was minted for is now spent or rejected, so the pair
          // has no further legitimate use.
          clearPkceState();
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
          const next = toStoredTokens(response, existing);
          saveTokens(next);
          tokensRef.current = next;
          setStatus('authenticated');
          return;
        } catch {
          clearTokens();
        }
      }

      // A reason stashed before an RP-initiated logout redirect. The
      // redirect leaves the origin, so React state cannot carry it.
      setError((previous) => previous ?? takeSignOutReason());
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
    const endingTokens = tokensRef.current;

    // Local state goes first, unconditionally. Everything below this point
    // can fail — discovery can be unreachable, the issuer can refuse an
    // unregistered post-logout URI, the redirect can be blocked — and the
    // one outcome that must never depend on any of it is that this browser
    // stops holding a usable token.
    // Bumped BEFORE clearing, so any refresh that resumes after this point
    // sees a changed epoch no matter where in `signOut` it lands.
    sessionEpoch.current += 1;
    refreshInFlight.current = undefined;

    clearTokens();
    clearPkceState();
    tokensRef.current = undefined;
    setError(reason);
    setStatus('unauthenticated');

    // Then end the session at the issuer.
    //
    // Without this the sign-out was local only, and the consequence is
    // specific rather than theoretical: the issuer's session cookie
    // survives, so the next person at the same clinic workstation clicks
    // "Sign in", is silently re-authenticated with no credential prompt,
    // and lands on the previous clinician's patient. That is unauthorized
    // PHI access produced by the app's own sign-out button.
    void (async () => {
      try {
        const config = loadOidcConfig();
        const discovery = await fetchDiscoveryDocument(config.issuer);
        if (!discovery.end_session_endpoint) {
          // Nothing more this app can do: RP-initiated logout is OPTIONAL
          // and some issuers do not implement it. Local sign-out stands,
          // and the residual risk is the issuer session cookie described
          // above. Surfacing it here rather than failing silently.
          // A security control silently degrading is the thing to avoid
          // here: this is a deployment-configuration condition (the issuer
          // implements no RP-initiated logout) that an operator needs to
          // see, and it carries no PHI — only a fixed sentence.
          // eslint-disable-next-line no-console
          console.warn(
            'Issuer advertises no end_session_endpoint; signed out locally only. ' +
              'The identity provider session may still be active in this browser.',
          );
          return;
        }

        // Stashed HERE, not at the top of `signOut`, and that placement is
        // the fix for a real defect: the reason only needs to survive a
        // NAVIGATION. Saving it unconditionally stranded it on the two
        // paths that never navigate — no `end_session_endpoint`, or
        // discovery failing — where React state already carries it to the
        // login page. It then sat in storage until some unrelated later
        // load announced "you were signed out because this page was not
        // used for a while" about a session that ended normally.
        if (reason) {
          saveSignOutReason(reason);
        }

        const logoutUrl = new URL(discovery.end_session_endpoint);
        logoutUrl.searchParams.set('client_id', config.clientId);
        logoutUrl.searchParams.set('post_logout_redirect_uri', config.postLogoutRedirectUri);
        if (endingTokens?.idToken) {
          // RECOMMENDED by RP-Initiated Logout §2, and load-bearing in
          // practice: without it most issuers show a "do you want to sign
          // out?" interstitial instead of ending the session — exactly the
          // confirmation a clinician walking away will never complete.
          logoutUrl.searchParams.set('id_token_hint', endingTokens.idToken);
        }
        window.location.assign(logoutUrl.toString());
      } catch {
        // Discovery failed. Local sign-out already happened, which is the
        // part that protects this browser.
      }
    })();
  }, []);

  /**
   * Inactivity timeout for shared workstations, with the pre-expiry warning
   * WCAG 2.2.1 (Timing Adjustable, Level A) requires.
   *
   * The access token's expiry is not this control. A token is valid for as
   * long as the issuer says regardless of who is at the keyboard, and the
   * physician view is a screen showing one named patient's stoma output. A
   * clinic workstation left unattended on it is an unauthorized disclosure
   * waiting for whoever sits down next — the ordinary case this guards, not
   * an attacker.
   *
   * ## Elapsed time, not a timer
   *
   * The obvious implementation — `setTimeout(timeout)`, cleared and
   * re-armed on each event — is wrong in the two situations that matter
   * most. Browsers throttle timers in background tabs, and a suspended
   * laptop does not run them at all, so a machine left locked overnight
   * with the tab open is the exact case where a naive timer fires late or
   * not at all. Comparing a recorded timestamp against `Date.now()` on a
   * poll is correct across both: the clock advances even when the timer
   * does not.
   *
   * ## Which events count as activity
   *
   * Deliberate interactions only. `mousemove` is excluded on purpose:
   * a mouse nudged by a passing cart, or a jittery optical sensor on a
   * shared desk, would keep an unattended session alive indefinitely —
   * which is precisely the session this exists to end.
   *
   * ## The warning, and why it is not optional
   *
   * Ending a session with no notice fails SC 2.2.1 at Level A, and the
   * "essential" exception does not rescue it: a single keypress already
   * extends this session, so extending it cannot invalidate the activity.
   * See `IdleWarningDialog` for the full exception analysis. The lead time
   * is 60 seconds against the SC's 20-second floor, and dismissing the
   * warning is itself activity, so it can be extended repeatedly.
   */
  useEffect(() => {
    if (status !== 'authenticated') {
      return;
    }

    let idleTimeoutMinutes: number;
    try {
      idleTimeoutMinutes = loadOidcConfig().idleTimeoutMinutes;
    } catch {
      // Unreachable while authenticated (the same call succeeded during
      // initialize), but the alternative to catching is an unhandled throw
      // in an effect, which unmounts the tree.
      return;
    }
    if (idleTimeoutMinutes <= 0) {
      return;
    }

    const timeoutMs = idleTimeoutMinutes * 60_000;
    // Never warn at or past the deadline, which is what a naive subtraction
    // would do for any timeout under the lead time.
    const warnAfterMs = Math.max(timeoutMs / 2, timeoutMs - IDLE_WARNING_LEAD_MS);

    const noteActivity = () => {
      lastActivityAt.current = Date.now();
      setIdleWarningVisible(false);
    };

    const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, noteActivity, { passive: true });
    }

    noteActivity();

    // Poll an order of magnitude finer than the timeout, so the session
    // ends within a few seconds of the deadline rather than up to a full
    // poll late — and so the warning appears with its full lead time.
    const interval = window.setInterval(() => {
      const idleFor = Date.now() - lastActivityAt.current;
      if (idleFor >= timeoutMs) {
        signOutRef.current('session_idle');
      } else if (idleFor >= warnAfterMs) {
        setIdleWarningVisible(true);
      }
    }, IDLE_POLL_INTERVAL_MS);

    return () => {
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, noteActivity);
      }
      window.clearInterval(interval);
      setIdleWarningVisible(false);
    };
  }, [status]);

  /** Dismisses the warning and restarts the idle clock. Same bookkeeping a keypress does. */
  const staySignedIn = useCallback(() => {
    lastActivityAt.current = Date.now();
    setIdleWarningVisible(false);
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

    const epoch = sessionEpoch.current;
    // `Promise.resolve().then(...)`, not an immediately-invoked async
    // function, and the difference is load-bearing twice over.
    //
    // An IIFE runs everything up to its first `await` SYNCHRONOUSLY, before
    // `refreshInFlight.current = refresh` on the last line of this block. So
    // a synchronous throw from `loadOidcConfig()` would run the whole
    // try/catch/finally first — and then the assignment below would install
    // an already-settled `undefined` promise, which every later caller
    // joins forever: the session wedges with no refresh ever attempted and
    // no recovery but a reload. Deferring the body to a microtask
    // guarantees the ref is set before any of it runs, which also makes the
    // identity comparison in `finally` meaningful.
    const refresh: Promise<string | undefined> = Promise.resolve().then(async () => {
      try {
        const config = loadOidcConfig();
        const discovery = await fetchDiscoveryDocument(config.issuer);
        const response = await refreshAccessToken({
          tokenEndpoint: discovery.token_endpoint,
          clientId: config.clientId,
          audience: config.audience,
          refreshToken: current.refreshToken as string,
        });
        if (epoch !== sessionEpoch.current) {
          // Signed out while this was in flight. The issuer has minted a
          // live token set; clearing rather than merely discarding it
          // matters because `toStoredTokens` has already been told to carry
          // the refresh token forward, and none of it may reach storage.
          clearTokens();
          return undefined;
        }
        const next = toStoredTokens(response, current);
        saveTokens(next);
        tokensRef.current = next;
        return next.accessToken;
      } catch {
        // Only sign out if this refresh still belongs to the current
        // session; otherwise a failure after sign-out would overwrite the
        // reason the user is already being shown.
        if (epoch === sessionEpoch.current) {
          signOutRef.current('session_expired');
        }
        return undefined;
      } finally {
        // Guarded, because `signOut` may already have cleared it and a
        // later call may have installed its own.
        if (refreshInFlight.current === refresh) {
          refreshInFlight.current = undefined;
        }
      }
    });

    refreshInFlight.current = refresh;
    return refresh;
  }, []);

  // Kept current so `getAccessToken` can call it without depending on it.
  signOutRef.current = signOut;

  const value = useMemo<AuthContextValue>(
    () => ({ status, error, signIn, signOut, getAccessToken }),
    [status, error, signIn, signOut, getAccessToken],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {/*
        Rendered by the provider rather than exposed through the context for
        a route to mount. A Level A control that each new screen has to
        remember to render is a control that will eventually be missing from
        one of them.
      */}
      {idleWarningVisible ? (
        <IdleWarningDialog onStaySignedIn={staySignedIn} onSignOut={() => signOut()} />
      ) : null}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth() must be called within an <AuthProvider>.');
  }
  return context;
}
