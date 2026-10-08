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
 * Fetches the profile once per client, not once per day.
 *
 * Keyed on `apiClient` alone: the profile does not vary by the date being
 * viewed, and folding it into the observations effect would refetch it on every
 * press of "previous day".
 *
 * This app is online-only by explicit decision (SRS §4.2), so there is no cache
 * and no offline path — a failure here is a failure to know, which is why the
 * page waits rather than rendering amounts in a guessed system.
 */
export function useProfile({ apiClient, onUnauthenticated }: UseProfileOptions): ProfileState {
  const [state, setState] = useState<ProfileState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    setState({ status: 'loading' });
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
        if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
          setState({ status: 'not-provisioned' });
          return;
        }
        setState({ status: 'error' });
      });

    return () => {
      cancelled = true;
    };
  }, [apiClient, onUnauthenticated]);

  return state;
}
