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
  /** Runs the biometric/passcode prompt and, on success, transitions to `authenticated` — see this file's header comment for what a concurrent refresh failure does and does not affect. */
  readonly unlock: () => Promise<LocalUnlockOutcome>;
  /** Called by `app/login.tsx` once the OIDC code exchange succeeds. Persists the refresh token (if the provider returned one) and transitions to `authenticated`. */
  readonly completeLogin: (tokens: OidcTokens) => Promise<void>;
  readonly signOut: () => Promise<void>;
  /** Screens call this on meaningful interaction so the foreground idle lock does not fire mid-use. */
  readonly markActivity: () => void;
}

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
          // Reason first. If the purge then fails, the patient sees an explanation
          // for a sign-out that did not happen, which is confusing; the other order
          // signs them out with no explanation, which is the defect being fixed.
          // Both self-heal on the next cold start, and the first is the kinder one.
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

  const reportSignInFailure = useCallback(() => {
    setSignInFailed(true);
  }, []);

  const clearSignInFailure = useCallback(() => {
    setSignInFailed(false);
  }, []);

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
        await recordSignedOutReason('unlock-settings-changed');
        await clearRefreshToken();
        setSignedOutReason('unlock-settings-changed');
        setPhase('signedOut');
        return outcome;
      }
    } catch {
      // Unreadable keychain says nothing about enrolment — fall through and unlock,
      // for the same reason the cold-start check answers `false` on failure.
    }

    setPhase('authenticated');

    // Best-effort only — see this file's header comment. A failure here
    // (offline, expired refresh token, provider unreachable) never
    // reverts the phase transition above; it only means `accessToken`
    // stays unset until the next successful attempt, which blocks a
    // sync network call and nothing else.
    if (discovery) {
      try {
        // Inside the try, not before it. This read prompts for biometrics
        // (requireAuthentication), so a cancelled sheet rejected out of
        // `unlock()` — and `handleUnlock` has no catch, so it became an
        // unhandled rejection with nothing shown. The same defect signOut
        // was just fixed for.
        const storedRefreshToken = await getRefreshToken();
        if (!storedRefreshToken) {
          /**
           * The marker said a session existed and the token is not there, which on a
           * GATED entry means one thing: the OS invalidated the key because biometric
           * enrolment changed. This is where that is detected, from the read itself
           * rather than inferred from `getEnrolledLevelAsync` — which dips on a
           * locked-out sensor and would purge good sessions (see
           * `storedTokenIsStaleForEnrolment`).
           *
           * Before this, the early return left the patient in `authenticated` with no
           * access token and no route to a re-login: sync silently never worked again
           * while every screen truthfully reported entries saved. Reachable only
           * since local unlock started accepting the device passcode, because until
           * then such a patient could not get past the prompt at all.
           *
           * Deliberately inside `if (discovery)`, so it cannot fire for an offline
           * patient. They do not need the token yet, and signing them out would
           * strand them in a network login they cannot complete.
           */
          await recordSignedOutReason('unlock-settings-changed');
          await clearRefreshToken();
          setSignedOutReason('unlock-settings-changed');
          setPhase('signedOut');
          return outcome;
        }
        const tokens = await refreshAccessToken(discovery, config, storedRefreshToken);
        setAccessToken(tokens.accessToken);
        if (tokens.refreshToken !== undefined) {
          await setRefreshToken(tokens.refreshToken);
        }
      } catch {
        // Deliberately swallowed — see header comment. Nothing PHI-bearing
        // or security-sensitive may be logged from a catch here in any
        // case (CLAUDE.md "never log PHI"; this app has no crash-reporting
        // sink at all per docs/sync-contract.md §10's BAA note), and a
        // failed refresh has a defined, safe fallback: the next screen
        // that actually needs a network call surfaces its own failure.
      }
    }

    return outcome;
  }, [discovery, config]);

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
