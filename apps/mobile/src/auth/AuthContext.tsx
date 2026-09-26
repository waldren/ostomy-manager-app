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

import { AppState } from 'react-native';

import i18next from '../i18n/i18n';

import { authenticate, type LocalUnlockOutcome } from './biometricUnlock';
import { deriveAuthPhase, type AuthPhase } from './authPhase';
import { readSubjectClaim } from './tokenSubject';
import { getDatabaseOwner, setDatabaseOwner } from '../db/databaseOwner';
import { purgeLocalDatabase } from '../db/purge';
import { getOidcClientConfig } from './oidcConfig';
import {
  useAutoDiscovery,
  accessTokenNeedsRenewal,
  isRefreshTokenRejected,
  refreshAccessToken,
  revokeRefreshToken,
  type OidcTokens,
} from './oidcSession';
import {
  clearRefreshToken,
  getRefreshToken,
  clearSignedOutReason,
  hasStoredRefreshToken,
  readSignedOutReason,
  recordSignedOutReason,
  setRefreshToken,
  storedTokenIsStaleForEnrolment,
  type SignedOutReason,
} from './tokenStorage';

/**
 * **Design decision, stated here because it is the one a reviewer is most
 * likely to want to relitigate:** a successful biometric unlock is
 * sufficient for LOCAL app access, independent of whether the subsequent
 * access-token refresh network call succeeds.
 *
 * `apps/mobile` is the only offline-capable client, built specifically for
 * a patient who "logs in public restrooms and while traveling" (CLAUDE.md).
 * If unlocking required a live network round trip to succeed, the app
 * would be unusable in exactly the situations it exists to handle. A
 * missing or stale access token blocks only the sync push/pull network
 * calls themselves (P2.S2b) — never local entry, never reading local
 * history, never anything this app can do without the network. See
 * `apps/mobile/README.md` "Architecture notes for the next sprint".
 */
export interface AuthContextValue {
  readonly phase: AuthPhase;
  /**
   * Whether the last sign-in attempt failed, surviving a remount of the screen
   * that started it (ADR-0021).
   *
   * It lives here rather than in `app/login.tsx`'s `useState` because the OIDC
   * redirect NAVIGATES — `/redirect` -> `/` -> `/login` — and that remounts the
   * login screen, discarding any failure it had set. That is the whole reason
   * #72 read as "the screen flashes and goes back to sign in": the message was
   * written and then thrown away, in the same moment, by the navigation the
   * redirect itself caused.
   *
   * Any outcome of an OIDC round trip has that problem, not just this one, so
   * the state belongs above the route.
   */
  readonly signInFailed: boolean;
  /** Records that a sign-in attempt failed. Called by `app/redirect.tsx`, which cannot render the message itself. */
  readonly reportSignInFailure: () => void;
  /** Clears it, when a fresh attempt starts. */
  readonly clearSignInFailure: () => void;
  /**
   * Why the app signed the patient out on its own, if it did (#74).
   *
   * Persisted rather than held here, because the purge deletes the marker the
   * condition is derived from and the remedy is a NETWORK login — a patient who
   * cannot complete it will close the app and come back, and the explanation has to
   * still be there. See `tokenStorage.ts`'s `SIGNED_OUT_REASON_KEY`.
   */
  readonly signedOutReason: SignedOutReason | undefined;
  readonly accessToken: string | undefined;
  /**
   * The access token to put on the next request, refreshed first if it is at or near
   * expiry.
   *
   * Every API call goes through this rather than reading `accessToken` directly, and
   * that is the point: an access token lives for minutes and a session lives for
   * days, so expiry mid-session is the ordinary case, not an edge. Before this,
   * `expiresAtSeconds` was captured and never consulted — so a token simply lapsed,
   * every request 401'd, the sync worker stopped with `unauthenticated` (which
   * schedules no retry), and nothing recovered until the next lock and unlock. Same
   * silent symptom as #40 and #59, a third cause.
   *
   * Returns `undefined` when there is nothing to send — offline with a lapsed token,
   * or no session at all. The caller then gets a 401 and the worker's ordinary
   * unauthenticated handling, which is correct: this cannot invent a credential.
   */
  readonly getFreshAccessToken: () => Promise<string | undefined>;
  /** Runs the biometric/passcode prompt and, on success, transitions to `authenticated` — see this file's header comment for what a concurrent refresh failure does and does not affect. */
  readonly unlock: () => Promise<LocalUnlockOutcome>;
  /** Called by `app/login.tsx` once the OIDC code exchange succeeds. Persists the refresh token (if the provider returned one) and transitions to `authenticated`. */
  readonly completeLogin: (tokens: OidcTokens) => Promise<void>;
  readonly signOut: () => Promise<void>;
  /** Screens call this on meaningful interaction so the foreground idle lock does not fire mid-use. */
  readonly markActivity: () => void;
}

/**
 * What happened when the app tried to obtain a fresh access token.
 *
 * A result rather than a thrown error, because the four failures call for four
 * different responses and `unlock()` is the only caller that can make some of them
 * — re-locking, in particular, is a screen-level decision.
 */
type AccessTokenRenewal =
  | { readonly outcome: 'renewed'; readonly accessToken: string }
  /** The marker said a session existed and the stored token is gone: an OS-invalidated key. */
  | { readonly outcome: 'no-session' }
  /** The keychain read itself threw — a cancelled sheet, a locked-out sensor. Says nothing about the session. */
  | { readonly outcome: 'unreadable' }
  /** The issuer rejected the refresh token. The session has already been ended. */
  | { readonly outcome: 'rejected' }
  /** Unknown fate: offline, no discovery document yet, a 5xx. The session survives. */
  | { readonly outcome: 'unavailable' };

/**
 * How long the app may sit backgrounded before it re-locks on return.
 *
 * Short, but not zero: a patient who switches out to check a message, or
 * whom iOS briefly backgrounds for a system prompt, should not have to
 * re-authenticate to finish logging the entry they were mid-way through.
 */
const BACKGROUND_RELOCK_GRACE_MS = 60_000;

/**
 * How long the app may sit untouched in the FOREGROUND before it re-locks.
 *
 * This is the phone-left-face-up-on-a-table case, and it is the one that
 * matters for this product: SRS 5.2 carries "automated session timeouts"
 * forward as a v1 requirement, and this app is explicitly designed for use
 * "in public restrooms and while traveling" — the population most exposed
 * to an unattended unlocked screen.
 */
const FOREGROUND_IDLE_LOCK_MS = 5 * 60_000;

/** Coarse enough to cost nothing, fine enough that the lock is punctual. */
const IDLE_POLL_INTERVAL_MS = 15_000;

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [phase, setPhase] = useState<AuthPhase>('checking');
  const [signInFailed, setSignInFailed] = useState(false);
  const [accessToken, setAccessToken] = useState<string | undefined>(undefined);
  const [signedOutReason, setSignedOutReason] = useState<SignedOutReason | undefined>(undefined);
  // Mirrors of the token, for the async accessor below. It is a stable callback so
  // that `SyncProvider`'s client is not rebuilt on every token change, which means
  // it must not read either value from a closure.
  const accessTokenRef = useRef<string | undefined>(undefined);
  accessTokenRef.current = accessToken;
  /**
   * When the current access token expires, in epoch seconds, or `undefined` for "the
   * provider did not say".
   *
   * A ref and not state on purpose: nothing renders it, and making it state would
   * re-render every consumer of this context on each refresh for no visible change.
   */
  const accessTokenExpiresAtRef = useRef<number | undefined>(undefined);
  /** Single-flight guard — see `renewAccessToken`. */
  const renewalInFlight = useRef<Promise<AccessTokenRenewal> | undefined>(undefined);
  const lastActivityAt = useRef(Date.now());
  const backgroundedAt = useRef(0);
  const config = useMemo(() => getOidcClientConfig(), []);
  const discovery = useAutoDiscovery(config.issuer);

  useEffect(() => {
    let cancelled = false;
    /**
     * #74. A refresh token stored without the biometric gate carries the
     * enrolment level it was written at, and a rise means a biometric was
     * enrolled since — the transition ADR-0015 exists to respond to, and the one
     * case an app CAN observe (see `storedTokenIsStaleForEnrolment`).
     *
     * Purging here rather than at the point of enrolment because there is no
     * point of enrolment to hook: the OS offers no change signal, so the next
     * cold start is the first moment this app can know. The consequence for the
     * patient is ADR-0015's stated one either way — a full OIDC re-login — and
     * the token that login stores IS gated, because the level now allows it.
     *
     * Answering `false` on failure is deliberate. A keychain that cannot be read
     * says nothing about enrolment, and purging a session on that evidence would
     * push an offline patient into a network login they cannot complete. The
     * `hasStoredRefreshToken` call below fails toward `locked` for the same
     * reason.
     */
    const tokenIsStale = async (): Promise<boolean> => {
      try {
        return await storedTokenIsStaleForEnrolment();
      } catch {
        return false;
      }
    };

    tokenIsStale()
      .then(async (stale) => {
        if (stale) {
          // Not `endSession`: this runs before the phase is derived at all, and the
          // derivation below is what decides it. Same order and same reasoning as
          // that helper — reason first, because an explanation for a sign-out that
          // did not happen is merely confusing, while a sign-out with no explanation
          // is the defect being fixed.
          await recordSignedOutReason('unlock-settings-changed');
          await clearRefreshToken();
        }
        return Promise.all([hasStoredRefreshToken(), readSignedOutReason()]);
      })
      .then(([hasToken, reason]) => {
        if (cancelled) return;
        setSignedOutReason(reason ?? undefined);
        setPhase(deriveAuthPhase({ hasStoredRefreshToken: hasToken, unlockedThisSession: false }));
      })
      .catch(() => {
        // Fails toward `locked`, deliberately, and never toward
        // `signedOut`.
        //
        // Without a catch, `phase` stayed `'checking'` and the app rendered
        // its loading spinner permanently — no login, no offline diary, no
        // way out but reinstalling, which destroys the database.
        //
        // `locked` rather than `signedOut` because the keychain being
        // briefly unreadable says nothing about whether a token exists.
        // Routing to `signedOut` would push an offline patient into a
        // network OIDC login they cannot complete, for a session they
        // already have.
        if (cancelled) return;
        setPhase('locked');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Re-locks the app rather than signing out.
   *
   * The distinction matters for an offline-first client: signing out would
   * clear the refresh token and strand any queued entries behind a full
   * OIDC login that needs network the patient may not have. Re-locking
   * returns to the biometric gate, which works offline and is the same
   * barrier a cold start presents.
   */
  const lock = useCallback(() => {
    // Reset, so the next foregrounding is measured from this lock rather
    // than from a background that happened before it.
    backgroundedAt.current = Date.now();
    lastActivityAt.current = Date.now();
    setAccessToken(undefined);
    setPhase((current) => (current === 'authenticated' ? 'locked' : current));
  }, []);

  const markActivity = useCallback(() => {
    lastActivityAt.current = Date.now();
  }, []);

  /**
   * Session timeout: on returning from the background, and on foreground
   * idle.
   *
   * Both are needed and neither substitutes for the other. Backgrounding
   * covers the phone going into a pocket or being handed over; foreground
   * idle covers the phone left face-up and untouched on a table, which no
   * `AppState` transition ever reports.
   *
   * Elapsed time against a recorded timestamp, not a `setTimeout`: iOS and
   * Android suspend timers for a backgrounded app, so a timer armed before
   * backgrounding may not fire at all, and the clock is the only thing that
   * keeps running. This is the same reasoning `apps/web`'s idle timeout
   * uses, for the same reason.
   */
  useEffect(() => {
    if (phase !== 'authenticated') {
      return;
    }

    markActivity();
    // Armed, not left at its initial 0.
    //
    // The guard below is `Date.now() - backgroundedAt.current >= grace`,
    // and against 0 that is trivially true. After an OIDC login the app is
    // returning from the in-app browser, so an 'active' transition arrives
    // immediately after this effect subscribes — and the patient was
    // bounced to the unlock screen the instant they signed in. A stale
    // value from a previous background did the same thing after an unlock.
    backgroundedAt.current = Date.now();

    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        if (Date.now() - backgroundedAt.current >= BACKGROUND_RELOCK_GRACE_MS) {
          lock();
        } else {
          markActivity();
        }
        return;
      }
      // 'background' and 'inactive'. `inactive` also fires for the iOS app
      // switcher and incoming calls, which is the behaviour wanted here:
      // the switcher is exactly when a screenshot of the diary is taken.
      backgroundedAt.current = Date.now();
    });

    const interval = setInterval(() => {
      if (Date.now() - lastActivityAt.current >= FOREGROUND_IDLE_LOCK_MS) {
        lock();
      }
    }, IDLE_POLL_INTERVAL_MS);

    return () => {
      subscription.remove();
      clearInterval(interval);
    };
  }, [phase, lock, markActivity]);

  const completeLogin = useCallback(
    async (tokens: OidcTokens): Promise<void> => {
      // Establish who this database belongs to BEFORE anything can read or
      // write it.
      //
      // The exposure this closes, in full, is in `db/databaseOwner.ts`. The
      // short version: nothing in the local schema is scoped to a patient,
      // so on a shared or handed-down phone the next person to sign in reads
      // the previous patient's diary — and, once the sync worker lands,
      // pushes their queued entries into their own record under their own
      // identity, producing an audit row that names the wrong author for a
      // clinical entry.
      // The ID TOKEN, falling back to the access token.
      //
      // OIDC guarantees the id_token is a JWT with a `sub`; an access
      // token's format is provider-defined and may be opaque. Parsing the
      // access token meant that against such an issuer `subject` was
      // `undefined` on EVERY login, so the owner was never stored and every
      // routine sign-in purged the diary — including the same patient's,
      // destroying their unsynced entries.
      const subject = readSubjectClaim(tokens.idToken ?? tokens.accessToken);
      const owner = await getDatabaseOwner();
      if (owner !== subject) {
        // Covers both the different-patient case and the never-owned case (a
        // database left behind by a build from before this check existed).
        // `undefined` from a token this app could not parse also lands here,
        // which is the safe direction: purge rather than assume.
        await purgeLocalDatabase();
      }
      if (subject) {
        await setDatabaseOwner(subject);
      }

      if (tokens.refreshToken !== undefined) {
        await setRefreshToken(tokens.refreshToken);
      }
      setAccessToken(tokens.accessToken);
      // Recorded here too, not only on refresh: without it the token from a fresh
      // sign-in has no known expiry, so the accessor would treat it as
      // never-expiring and the first lapse would be a silent 401 again.
      accessTokenExpiresAtRef.current = tokens.expiresAtSeconds;
      markActivity();
      // A success clears any earlier failure here, not in the login screen: on
      // the path this exists for, that screen is about to mount fresh and would
      // otherwise render a stale error over a completed sign-in.
      setSignInFailed(false);
      // Cleared on success, never on an attempt: a patient who fails one try must
      // not lose the explanation for why they are signing in at all. Best-effort —
      // a stale explanation is a far smaller problem than a failed sign-in, and
      // this runs after the token is already stored.
      setSignedOutReason(undefined);
      void clearSignedOutReason().catch(() => undefined);
      setPhase('authenticated');
    },
    [markActivity],
  );

  /**
   * Ends the session the app itself decided to end, and records why.
   *
   * Three callers reach this — an enrolment change detected at cold start, the same
   * detected at unlock, and a refresh token the issuer rejected (#40) — and they had
   * begun to diverge, which for something that clears a credential is how one of
   * them quietly stops clearing it.
   *
   * `clearRefreshToken`, never `signOut`. ADR-0014's asymmetry is deliberate and
   * load-bearing here: the SQLCipher key carries no `requireAuthentication`, so the
   * diary and anything still queued survive this, and the patient signs back in to
   * find their entries where they left them. Purging would make an expired sign-in
   * cost them data, which is the opposite of what any of these cases call for.
   *
   * **It does not revoke at the issuer, and that is a decision rather than an
   * omission.** For `session-expired` there is nothing to revoke — the issuer has
   * already rejected the token. For an enrolment change the token may still be
   * valid at the issuer, and `signOut` does revoke in that situation; the
   * difference is that revoking requires READING the token, and on the enrolment
   * path the whole point is that the stored token is unreadable or must not be
   * read. ADR-0015 leans on the re-login reaching the issuer for its audit trail,
   * which means that trail appears when the patient signs back in and not at the
   * moment the session ends. Stated here rather than left to be inferred from the
   * absence of a call.
   *
   * Errors are swallowed on purpose. Every caller is already inside a path where a
   * rejection would escape as an unhandled one — `handleUnlock` has no catch, a
   * defect this file has been bitten by twice — and the phase change is the part the
   * patient needs. A failed purge self-heals at the next cold start, which re-runs
   * the same check.
   */
  const endSession = useCallback(async (reason: SignedOutReason): Promise<void> => {
    try {
      // Reason first: a recorded reason for a sign-out that did not happen is merely
      // confusing, while a sign-out with no reason is the defect being fixed.
      await recordSignedOutReason(reason);
      await clearRefreshToken();
    } catch {
      // See above.
    }
    setSignedOutReason(reason);
    // Before the phase flips. `signOut` does this too, and for the same reason: the
    // context would otherwise hand a live bearer credential to any component while
    // `phase === 'signedOut'`, which contradicts what that phase means. Narrow in
    // practice — nothing reads `accessToken` outside the phase gate — but a phase
    // claiming less than the session holds is the mirror of the bug this whole
    // change is about.
    setAccessToken(undefined);
    accessTokenExpiresAtRef.current = undefined;
    setPhase('signedOut');
  }, []);

  const reportSignInFailure = useCallback(() => {
    setSignInFailed(true);
  }, []);

  const clearSignInFailure = useCallback(() => {
    setSignInFailed(false);
  }, []);

  /**
   * Exchanges the stored refresh token for a new access token. The **only** place
   * this app refreshes.
   *
   * ## Single-flight, and why that is a correctness requirement
   *
   * Concurrent refreshes are not merely wasteful. An issuer that ROTATES refresh
   * tokens invalidates the superseded one, so the second of two overlapping
   * refreshes gets `invalid_grant` — and this app treats `invalid_grant` as "the
   * session is over" (#40), so it would sign the patient out of a perfectly good
   * session. `isRefreshTokenRejected` records that hazard and says a single-flight
   * guard is what a background refresh needs first; making every API call able to
   * trigger a refresh is exactly that background refresh, so here is the guard.
   * Cognito does not rotate, but the app must not depend on which issuer it is
   * pointed at.
   *
   * Callers awaiting an in-flight attempt get its result rather than starting
   * another, which also means a burst of requests at cold start produces one refresh.
   *
   * ## Why it reports instead of throwing
   *
   * The four failures need four different responses, and only `unlock()` can make
   * some of them — re-locking the app is a decision about a screen, not about a
   * token. See `AccessTokenRenewal`.
   */
  const renewAccessToken = useCallback(async (): Promise<AccessTokenRenewal> => {
    const existing = renewalInFlight.current;
    if (existing !== undefined) return existing;

    const attempt = (async (): Promise<AccessTokenRenewal> => {
      try {
        // No discovery document means no token endpoint to ask, which is the
        // ordinary offline case rather than a failure.
        if (!discovery) return { outcome: 'unavailable' };

        /**
         * The read is separated from the refresh because a read that throws and a
         * read that answers nothing mean different things, and one shared `try`
         * conflated them back into #40 (found by review).
         *
         * A rejection is not an `invalid_grant`, so it used to fall through to the
         * swallow and leave the app `authenticated` holding no access token — the
         * pre-#40 state exactly. Three things reach it: the patient cancelling the OS
         * sheet that a gated read raises on Android, biometry locked out after failed
         * presses, and an invalidated key IF the platform surfaces that as a
         * rejection rather than as `null`. That last is **unverified** — Android's
         * `SecureStoreModule` returns `null`, but nothing has run on hardware and iOS
         * may differ — so both answers are handled.
         */
        let storedRefreshToken: string | null = null;
        try {
          storedRefreshToken = await getRefreshToken();
        } catch {
          // Nothing may be logged: the only values in scope are a bearer credential
          // and a keychain error (CLAUDE.md, "never log PHI").
          return { outcome: 'unreadable' };
        }

        /**
         * The marker said a session existed and the token is not there, which on a
         * GATED entry means one thing: the OS invalidated the key because biometric
         * enrolment changed. Detected from the read itself rather than inferred from
         * `getEnrolledLevelAsync`, which dips on a locked-out sensor and would purge
         * good sessions (see `storedTokenIsStaleForEnrolment`).
         *
         * Before this was handled, the patient sat in `authenticated` with no access
         * token and no route to a re-login: sync silently never worked again while
         * every screen truthfully reported entries saved.
         */
        if (!storedRefreshToken) return { outcome: 'no-session' };

        const tokens = await refreshAccessToken(discovery, config, storedRefreshToken);
        accessTokenExpiresAtRef.current = tokens.expiresAtSeconds;
        setAccessToken(tokens.accessToken);
        if (tokens.refreshToken !== undefined) {
          await setRefreshToken(tokens.refreshToken);
        }
        return { outcome: 'renewed', accessToken: tokens.accessToken };
      } catch (error) {
        /**
         * #40. A refresh the ISSUER rejected is not an unknown fate.
         *
         * `invalid_grant` means the refresh token is expired, revoked, or not ours
         * (RFC 6749 §5.2). Nothing retries out of that, so the session is over.
         * `isRefreshTokenRejected` is deliberately narrow — a network failure, a 5xx
         * or `temporarily_unavailable` all keep the session, because this app is used
         * offline by design and signing a patient out of a diary they can still write
         * in is the worse of the two errors.
         */
        if (isRefreshTokenRejected(error)) {
          await endSession('session-expired');
          return { outcome: 'rejected' };
        }
        // Nothing PHI-bearing or security-sensitive may be logged from here in any
        // case, and there is no crash-reporting sink to log it to.
        return { outcome: 'unavailable' };
      } finally {
        renewalInFlight.current = undefined;
      }
    })();

    renewalInFlight.current = attempt;
    return attempt;
  }, [discovery, config, endSession]);

  /**
   * See `AuthContextValue.getFreshAccessToken`. Stable, and reads both values through
   * refs, so `SyncProvider`'s API client is not rebuilt whenever the token changes.
   */
  const getFreshAccessToken = useCallback(async (): Promise<string | undefined> => {
    const current = accessTokenRef.current;
    if (
      current !== undefined &&
      !accessTokenNeedsRenewal(accessTokenExpiresAtRef.current, Date.now())
    ) {
      return current;
    }
    const renewal = await renewAccessToken();
    return renewal.outcome === 'renewed' ? renewal.accessToken : undefined;
  }, [renewAccessToken]);

  const unlock = useCallback(async (): Promise<LocalUnlockOutcome> => {
    // `expo-local-authentication`'s `promptMessage` is rendered by the
    // operating system's own biometric sheet, not by this app's JSX tree —
    // there is no node for the `i18next/no-literal-string` lint rule (which
    // only scans JSX) to catch here. It still comes from the catalog: the
    // text is user-facing regardless of which layer renders it, and
    // CLAUDE.md's "no hardcoded user-facing strings" rule is not scoped to
    // what a lint rule happens to reach.
    const outcome = await authenticate(i18next.t('mobile:login.unlockPromptMessage'));
    if (outcome.outcome !== 'success') return outcome;

    /**
     * #74. Checked here as well as at cold start, because an Android process can
     * live for days and the cold-start check is otherwise the only one.
     *
     * Without this, an attacker who enrols their own biometric while the process is
     * alive can open the app at the lock screen, satisfy the OS prompt with the
     * print they just added, and have `getRefreshToken()` below hand them a live
     * bearer credential — no purge, no issuer round trip, no record anywhere. The
     * gated case has no such window: the OS invalidates the key the moment the
     * enrolment lands. Two native calls close most of the difference.
     *
     * The outcome still reports `success`, because it describes the PROMPT, which
     * did succeed. The phase is what routes the patient, and it goes to `signedOut`
     * with the reason recorded, so the login screen can say why.
     */
    try {
      if (await storedTokenIsStaleForEnrolment()) {
        await endSession('unlock-settings-changed');
        return outcome;
      }
    } catch {
      // Unreadable keychain says nothing about enrolment — fall through and unlock,
      // for the same reason the cold-start check answers `false` on failure.
    }

    setPhase('authenticated');

    /**
     * Best-effort, and `renewAccessToken` is now the single place this happens (the
     * `expiresAtSeconds` gap). A failure never reverts the phase transition above; it
     * means `accessToken` stays unset until something asks for one again, which blocks
     * a sync network call and nothing else.
     */
    const renewal = await renewAccessToken();
    if (renewal.outcome === 'unreadable') {
      // Re-locks rather than signing out. An unreadable keychain says nothing about
      // whether a session exists — the same argument the cold-start fallback makes —
      // and the patient can simply press Unlock again. Signing them out would push an
      // offline patient into a network login for a condition that may clear.
      lock();
      return outcome;
    }
    if (renewal.outcome === 'no-session') {
      await endSession('unlock-settings-changed');
      return outcome;
    }
    // 'rejected' has already ended the session; 'unavailable' is the documented
    // offline fallback; 'renewed' is the happy path.

    return outcome;
  }, [renewAccessToken, endSession, lock]);

  /**
   * Ends the session locally, at the issuer, and on disk.
   *
   * Order is deliberate: revoke first (it needs the token), then clear the
   * token, then destroy the local database. Every step after the first is
   * unconditional, so a failure to reach the issuer — the normal case for
   * an offline-first app — still leaves the device with no credential and
   * no clinical data.
   *
   * ## Why this purges, and what it costs
   *
   * "Sign out" is the affordance a patient uses precisely when they want
   * their data off a device: handing a phone to a family member, returning
   * a clinic-issued device, selling it. Leaving the diary on disk makes the
   * control a lie, and leaving a `sync_queue` behind is worse than that —
   * see `db/databaseOwner.ts` for how those rows end up attributed to the
   * next person who signs in.
   *
   * The cost is real and is NOT yet handled: unsynced queued entries are
   * destroyed with everything else. `docs/sync-contract.md` 9 is explicit
   * that a rejected operation is retained locally and surfaced for
   * correction, never dropped, and the same principle says a patient
   * should not silently lose entries they made offline. The correct
   * behaviour is to count pending operations and warn before purging —
   * "you have N entries that haven't synced yet" — which needs UI that
   * does not exist in this sprint.
   *
   * Purging unconditionally is the deliberate choice in the meantime,
   * because the alternative is leaving one patient's clinical values on a
   * device for the next patient, and a disclosure is worse than a loss the
   * patient initiated. Recorded in the README as the follow-up that must
   * land with the sync worker (P2.S2b), when there is finally something in
   * the queue to lose.
   */
  const signOut = useCallback(async (): Promise<void> => {
    // The read is GUARDED, and that is the whole correctness of this
    // function.
    //
    // It was the first statement and unguarded. `requireAuthentication`
    // (ADR-0015) makes it prompt for biometrics, so a patient who
    // dismissed that sheet — or whose biometry was locked out after failed
    // attempts, or whose key the OS had invalidated — got a rejection
    // BEFORE the token was cleared and before the database was purged.
    // Sign-out silently did nothing: they handed the phone over with the
    // refresh token and the entire diary still on it. The comment that
    // used to sit here claimed every step after the first was
    // unconditional; the unguarded read made that false.
    let storedRefreshToken: string | null = null;
    try {
      storedRefreshToken = await getRefreshToken();
    } catch {
      // Revocation is best-effort. Losing it costs a token that expires on
      // its own schedule; letting it block sign-out costs the patient
      // everything this function exists to remove.
    }

    // Each step in its OWN try, so none can skip another.
    //
    // They shared one, which meant a throw from revocation or from the
    // token clear skipped everything after it — and the function's own
    // comment claimed every step after the first was unconditional. A
    // `SecureStore.deleteItemAsync` failure is entirely reachable, and it
    // left BOTH the refresh token and the whole local diary on the device
    // while the UI reported a signed-out session. That is precisely the
    // HIPAA finding this function exists to close.
    if (discovery && storedRefreshToken) {
      try {
        await revokeRefreshToken(discovery, config, storedRefreshToken);
      } catch {
        // Best-effort: the token expires on its own schedule.
      }
    }

    try {
      await clearRefreshToken();
    } catch {
      // The purge below matters more, and must not be skipped for this.
    }

    try {
      await purgeLocalDatabase();
    } catch {
      // KNOWN GAP, and a real one: clinical data is still on this device
      // while the app reports a signed-out session. Surfacing it needs the
      // same screen as ADR-0014's unsynced-entry warning, which this
      // sprint does not have. Both must land with the sync worker.
    }

    // Always reached, now that no step above can throw: a failure anywhere
    // must still leave this app showing a signed-out session rather than
    // the previous patient's home screen.
    setAccessToken(undefined);
    accessTokenExpiresAtRef.current = undefined;
    // A reason left over from an earlier automatic sign-out must not survive to
    // explain a DELIBERATE one: a patient who simply signed out would otherwise be
    // told "The fingerprint, face, or screen lock on this phone changed", which is
    // false and alarming. `completeLogin` also clears it, best-effort, so a failure
    // here is recovered at the next sign-in rather than being permanent.
    setSignedOutReason(undefined);
    void clearSignedOutReason().catch(() => undefined);
    setPhase('signedOut');
  }, [discovery, config]);

  const value = useMemo<AuthContextValue>(
    () => ({
      phase,
      accessToken,
      unlock,
      completeLogin,
      signOut,
      markActivity,
      signInFailed,
      reportSignInFailure,
      clearSignInFailure,
      getFreshAccessToken,
      signedOutReason,
    }),
    [
      phase,
      accessToken,
      unlock,
      completeLogin,
      signOut,
      markActivity,
      signInFailed,
      reportSignInFailure,
      clearSignInFailure,
      getFreshAccessToken,
      signedOutReason,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth() must be called within an AuthProvider (see app/_layout.tsx).');
  }
  return value;
}
