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

import { createApiClient } from '@ostomy/core/api-client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

import { useAuth } from '../auth/AuthContext';
import { loadEnv } from '../config/env';
import { useDatabaseState } from '../db/DatabaseProvider';
import { readProfile, writeProfile, type LocalProfile } from '../db/repositories/profileRepository';
import { now, toWireInstant } from '../lib/utils/clock';

import { lookUpProfile, type ProfilePort } from './provisionProfile';

/**
 * Whether this patient has a profile, and therefore whether they see their diary
 * or the three questions.
 *
 * Four states, and the fourth is the one worth reading twice.
 */
export type ProfileState =
  /** Still reading the local row, or asking the server. Nothing is known yet. */
  | { readonly status: 'checking' }
  | { readonly status: 'present'; readonly profile: LocalProfile }
  /**
   * The server said `PATIENT_NOT_PROVISIONED`. This patient really is new, and the
   * three questions are the right screen.
   */
  | { readonly status: 'absent' }
  /**
   * This device has no profile and the server could not be reached, so which of the
   * two above is true is **unknown**.
   *
   * Kept apart from `absent` deliberately, and it is the same distinction
   * `docs/sync-contract.md` §9.3 draws between a rejection and unknown fate. A
   * device with no local row is not evidence of a new patient: a reinstall, a
   * different phone, or a store destroyed by a different subject signing in
   * (ADR-0014) all produce it for someone who onboarded months ago. Showing the
   * three questions on `unknown` would walk such a patient through a form whose
   * submit can only answer 409 — and, worse, would invite them to re-answer a
   * surgery date that is already recorded.
   */
  | { readonly status: 'unreachable' };

export interface ProfileContextValue {
  readonly state: ProfileState;
  /** Re-checks: the local row first, then the server if there is none. The onboarding screen's retry. */
  readonly refresh: () => Promise<void>;
  /** Records a profile this device has just been given, and moves the gate to `present`. */
  readonly adopt: (profile: LocalProfile) => Promise<void>;
  /** The endpoints the onboarding screen submits through. Shared so there is one client and one token path. */
  readonly port: ProfilePort;
}

const ProfileContext = createContext<ProfileContextValue | undefined>(undefined);

export function useProfileState(): ProfileContextValue {
  const value = useContext(ProfileContext);
  if (value === undefined) {
    throw new Error('useProfileState must be used inside a <ProfileProvider>.');
  }
  return value;
}

/** The profile when there is one, and `undefined` otherwise — for the screens that only need the answer. */
export function useProfile(): LocalProfile | undefined {
  const { state } = useProfileState();
  return state.status === 'present' ? state.profile : undefined;
}

export interface ProfileProviderProps {
  readonly children: ReactNode;
  /** Test seam. Production builds the real client from `loadEnv()`, exactly as `SyncProvider` does. */
  readonly port?: ProfilePort;
}

export function ProfileProvider({ children, port }: ProfileProviderProps): React.JSX.Element {
  const { phase, getFreshAccessToken } = useAuth();
  const database = useDatabaseState();
  const [state, setState] = useState<ProfileState>({ status: 'checking' });

  /**
   * Read through a ref inside the effect rather than captured in the closure, for
   * `SyncProvider`'s reason: an accessor captured at mount closes over a stale
   * token path, and an access token lives for minutes while a session lives for
   * days.
   */
  const getAccessTokenRef = useRef(getFreshAccessToken);
  getAccessTokenRef.current = getFreshAccessToken;

  const resolvedPort = useMemo<ProfilePort>(() => {
    if (port) return port;
    const api = createApiClient({
      baseUrl: loadEnv().apiUrl,
      getAccessToken: () => getAccessTokenRef.current(),
    });
    return {
      provision: (body) => api.onboarding.provision(body),
      read: () => api.onboarding.profile(),
    };
  }, [port]);

  const executor = database.status === 'ready' ? database.executor : undefined;

  const adopt = useCallback(
    async (profile: LocalProfile) => {
      // Written to the device before the gate opens, not after: the dashboard reads
      // the local row, and a `present` state ahead of the write would render one
      // frame with a profile that is not there yet.
      if (executor !== undefined) await writeProfile(executor, profile, toWireInstant(now()));
      setState({ status: 'present', profile });
    },
    [executor],
  );

  const check = useCallback(async () => {
    if (executor === undefined) return;

    /**
     * The local row first, and the server only when there is none.
     *
     * This is what makes the gate work offline, which it has to: a patient who
     * unlocks on a plane must reach their diary. It also means a provisioned
     * patient costs no request at launch — and that the server is never asked to
     * confirm what the device already knows, so a 5xx cannot lock someone out of
     * their own entries.
     */
    const local = await readProfile(executor);
    if (local !== undefined) {
      setState({ status: 'present', profile: local });
      return;
    }

    const lookup = await lookUpProfile(resolvedPort);
    if (lookup.status === 'found') {
      // A patient who onboarded elsewhere, or reinstalled. Recording it here is what
      // keeps the next launch from asking again.
      await adopt(lookup.profile);
      return;
    }
    setState(
      lookup.status === 'not-provisioned' ? { status: 'absent' } : { status: 'unreachable' },
    );
  }, [adopt, executor, resolvedPort]);

  useEffect(() => {
    /**
     * Only once authenticated. `locked` and `signedOut` have no token, so a lookup
     * would 401 and report `unreachable` — which the onboarding screen would then
     * explain as a connection problem to someone who is simply not signed in yet.
     */
    if (phase !== 'authenticated' || executor === undefined) {
      setState({ status: 'checking' });
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        if (!cancelled) await check();
      } catch {
        // A failed check must never take the app down. `unreachable` is the honest
        // state: this device does not know, and the screen offers a retry. Nothing
        // is logged — the failure would be described in terms of a profile, and a
        // profile is PHI.
        if (!cancelled) setState({ status: 'unreachable' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [check, executor, phase]);

  const value = useMemo<ProfileContextValue>(
    () => ({ state, refresh: check, adopt, port: resolvedPort }),
    [adopt, check, resolvedPort, state],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}
