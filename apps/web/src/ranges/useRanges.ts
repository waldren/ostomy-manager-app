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
import { useEffect, useState } from 'react';

/**
 * The patient's target ranges (P4.S2 slice 4, SRS §3.9).
 *
 * Shaped like `useProfile` beside it, and for the same reasons: fetched once per
 * client rather than per day viewed, since a range does not vary with the date
 * on screen; and a 401 is lifted to the caller because the response to one is to
 * end the session, which is `AuthContext`'s business.
 */
export interface RangeBasis {
  readonly ostomyType: 'colostomy' | 'ileostomy';
  readonly daysPostOp: number;
  readonly minDaysPostOp: number;
  readonly maxDaysPostOp: number | null;
}

export interface ResolvedRange {
  readonly rangeType: string;
  readonly unit: string;
  readonly lowValue: number | null;
  readonly highValue: number | null;
  readonly provenance: string;
  /**
   * Whether this may be used as an anomaly threshold (AC 14.1 AC2).
   *
   * Carried from the server rather than derived from `provenance` here: the
   * server decides which provenance values count as confirmed, and a second
   * answer in the client is how the two come to disagree about whether a value
   * is a threshold.
   */
  readonly isActiveThreshold: boolean;
  readonly divergesFromPhysician: boolean;
  readonly basis: RangeBasis | null;
}

/**
 * Three states, not four.
 *
 * Unlike the profile, a failure here does **not** stop the page rendering: the
 * day's chart, table and balance do not depend on a target range, and taking the
 * clinical view away because a secondary read failed would be the wrong trade.
 * An empty list and a failed fetch are therefore both "nothing to show" as far
 * as the page is concerned — the component says which.
 */
export type RangesState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly ranges: readonly ResolvedRange[] }
  | { readonly status: 'error' };

export interface UseRangesOptions {
  readonly apiClient: ApiClient;
  readonly onUnauthenticated: () => void;
}

export function useRanges({ apiClient, onUnauthenticated }: UseRangesOptions): RangesState {
  const [state, setState] = useState<RangesState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    setState({ status: 'loading' });
    apiClient.ranges
      .list()
      .then((response) => {
        if (cancelled) return;
        setState({ status: 'loaded', ranges: response.ranges });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (error instanceof ApiError && error.status === 401) {
          onUnauthenticated();
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
