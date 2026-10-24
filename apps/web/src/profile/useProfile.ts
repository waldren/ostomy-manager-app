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

import { ApiError, type ApiClient } from '@ostomy/core/api-client';
import type { MeasurementSystem } from '@ostomy/core/units';
import { useEffect, useState } from 'react';

/**
 * The signed-in patient's profile, as this page needs it (P4.S1 slice 4).
 *
 * Only `measurementSystem` is read. `GET /api/v1/profile` also returns the
 * ostomy type and the surgery date, and this app has no use for either yet: it
 * renders no post-operative context, and it validates nothing because it writes
 * nothing. Narrowing here rather than passing the whole response through is what
 * keeps a reader from assuming this page reasons about a surgery date.
 */
export interface WebProfile {
  readonly measurementSystem: MeasurementSystem;
}

/**
 * Four states, and the last two are different problems with different answers.
 */
export type ProfileState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly profile: WebProfile }
  /**
   * `PATIENT_NOT_PROVISIONED` — this account has no profile at all.
   *
   * Not an error, and not fixable here: onboarding is in the mobile app
   * (ADR-0020 ships the only writing client on Android), so this page can say
   * what to do but cannot do it. Told apart from `error` because "try again"
   * is the wrong offer for a condition that does not resolve by trying — the
   * same trap #80 recorded for the mobile dashboard.
   */
  | { readonly status: 'not-provisioned' }
  | { readonly status: 'error' };

export interface UseProfileOptions {
  readonly apiClient: ApiClient;
  /**
   * Called when the API rejects the token. Lifted to the caller because the
   * response is to end the session, which is `AuthContext`'s business — and
   * because offering "try again" for a 401 is a button that can be pressed
   * forever (see `PhysicianOutputView`'s own note on the same case).
   */
  readonly onUnauthenticated: () => void;
}

/**
 * Fetches the profile once per client, not once per day, and again whenever
 * the tab becomes visible (P4.S4, #154).
 *
 * Keyed on `apiClient` alone: the profile does not vary by the date being
 * viewed, and folding it into the observations effect would refetch it on every
 * press of "previous day".
 *
 * ## Why it is read again when the tab comes back
 *
 * The profile is edited on the phone (P4.S3, through sync), so a patient who
 * switches to ounces in the app and then returns to a tab already open here
 * would otherwise keep reading millilitres until they reloaded. Returning to
 * the tab is exactly that moment, so that is when it asks; a timer would be a
 * request every few seconds from every open tab, for a value that changes
 * perhaps once in an account's life.
 *
 * ## What a failed second read does
 *
 * This app is online-only by explicit decision (SRS §4.2), so there is no cache
 * and no offline path — a failure on the FIRST read is a failure to know, which
 * is why the page waits rather than rendering amounts in a guessed system.
 *
 * A failure on a later read is different: the system is already known from a
 * read that succeeded, so nothing is guessed by keeping it, and blanking a page
 * the reader was just looking at because a refresh failed would be worse. Only
 * a 401 changes anything then, because it means the session is over.
 */
export function useProfile({ apiClient, onUnauthenticated }: UseProfileOptions): ProfileState {
  const [state, setState] = useState<ProfileState>({ status: 'loading' });
  const [readNonce, setReadNonce] = useState(0);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') setReadNonce((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []);

  // A new client is a new session's profile: start again from "loading".
  useEffect(() => {
    setState({ status: 'loading' });
  }, [apiClient]);

  useEffect(() => {
    let cancelled = false;

    apiClient.onboarding
      .profile()
      .then((profile) => {
        if (cancelled) return;
        setState({
          status: 'loaded',
          profile: { measurementSystem: profile.measurementSystem },
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          onUnauthenticated();
          return;
        }
        // A second read that fails keeps what the first one learned (see above).
        setState((previous) => {
          if (previous.status === 'loaded') return previous;
          if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
            return { status: 'not-provisioned' };
          }
          return { status: 'error' };
        });
      });

    // Only the latest read may answer: a slow first response landing after a
    // faster second one would otherwise put the old system back.
    return () => {
      cancelled = true;
    };
  }, [apiClient, onUnauthenticated, readNonce]);

  return state;
}
