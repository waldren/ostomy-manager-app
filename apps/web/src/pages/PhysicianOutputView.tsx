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

import { ApiError, type Observation } from '@ostomy/core/api-client';
import { formatDateTime } from '@ostomy/core/i18n';
import { unitsForMeasurementSystem, type MeasurementSystem } from '@ostomy/core/units';
import { Button, InlineNotice, NoticeIcon } from '@ostomy/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../auth/AuthContext.js';
import { createWebApiClient } from '../api/client.js';
import { DailyBalanceNotice } from '../components/DailyBalanceNotice.js';
import { DateNav } from '../components/DateNav.js';
import { OutputChart } from '../components/OutputChart.js';
import { OutputTable } from '../components/OutputTable.js';
import { UnitToggle } from '../components/UnitToggle.js';
import {
  toDisplayDailyTotal,
  toDisplayOutputEntries,
} from '../format/formatObservationsForDisplay.js';

type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | {
      readonly status: 'loaded';
      readonly observations: readonly Observation[];
      /** True when the day may hold more entries than were returned — see `DAILY_PAGE_SIZE`. */
      readonly truncated: boolean;
    };

/**
 * How many of a day's observations to ask for.
 *
 * The request sent no `limit` at all, which took the server's DEFAULT of
 * 100 (`OBSERVATION_LIST_DEFAULT_LIMIT`). On a high-output ileostomy — the
 * patients this view exists for — a day of frequent emptying can exceed
 * that, and the failure was silent in the worst possible way: the chart and
 * table simply ended, and the DAILY TOTAL was summed over the truncated set
 * and rendered as if it were the day's total. A physician assessing
 * hydration would read a confidently-wrong number that is low by however
 * much was cut, with nothing on screen suggesting it.
 *
 * 500 is the server maximum (`OBSERVATION_LIST_MAX_LIMIT`). Duplicated as a
 * literal rather than imported because `apps/web` cannot import from
 * `apps/api`, and it degrades safely: the contract clamps an oversized limit
 * rather than refusing it (`ObservationsListQuery.limit`), so if the server
 * maximum is ever lowered this asks for more than it gets, `truncated`
 * becomes true, and the user is warned instead of misinformed.
 */
const DAILY_PAGE_SIZE = 500;

function dayBoundsUtc(isoDate: string): { from: string; to: string } {
  const from = new Date(`${isoDate}T00:00:00.000Z`);
  const to = new Date(`${isoDate}T23:59:59.999Z`);
  return { from: from.toISOString(), to: to.toISOString() };
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The physician view (SRS §3.5). This minimal slice covers stoma output
 * only — the first, and so far only, hydration signal available through
 * `GET /api/v1/observations` (P2.S1a). It deliberately does NOT compute a
 * Daily Net Fluid Balance figure: see `DailyBalanceNotice`.
 *
 * This is emphatically not the patient dashboard (SRS §3.12): there is no
 * composite status here, and there will not be one even once the other
 * three hydration signals exist — this view keeps them separate and
 * uncombined, always.
 */
export function PhysicianOutputView() {
  const { t } = useTranslation();
  const { getAccessToken, signOut } = useAuth();
  const apiClient = useMemo(() => createWebApiClient(getAccessToken), [getAccessToken]);

  const [isoDate, setIsoDate] = useState(todayIsoDate);
  const [displaySystem, setDisplaySystem] = useState<MeasurementSystem>('metric');
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  /**
   * Bumped on every load. A response is applied only if its ticket is still
   * the current one.
   *
   * Without this, clicking "previous day" three times fires three overlapping
   * requests and applies them in ARRIVAL order, not request order — so the
   * last response to land wins while `DateNav` still shows the date the user
   * actually chose. A clinician reads one day's volumes and daily total under
   * another day's heading. That is a wrong-clinical-data-under-a-wrong-label
   * defect reachable by ordinary use on a slow LAN, not a cosmetic race.
   *
   * It also stops the `.then` writing state after unmount, which happens on
   * every sign-out: `signOut` flips status, `RequireAuth` navigates away, and
   * the in-flight request still resolves.
   */
  const requestTicket = useRef(0);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    const ticket = (requestTicket.current += 1);
    const isStale = () => ticket !== requestTicket.current;

    setState({ status: 'loading' });
    const { from, to } = dayBoundsUtc(isoDate);

    apiClient.observations
      .list({ effectiveDateTimeFrom: from, effectiveDateTimeTo: to, limit: DAILY_PAGE_SIZE })
      .then((response) => {
        if (isStale()) return;
        // `ObservationListResponse` carries no `hasMore`, so a full page is
        // the only truncation signal available. It over-reports by one case
        // — a day holding exactly DAILY_PAGE_SIZE entries — and that is the
        // right direction to be wrong in: warning that a correct total might
        // be incomplete costs a physician a second look, while presenting an
        // incomplete total as complete costs a clinical judgement.
        setState({
          status: 'loaded',
          observations: response.observations,
          truncated: response.observations.length >= DAILY_PAGE_SIZE,
        });
      })
      .catch((error: unknown) => {
        if (isStale()) return;
        // A 401 is not a retryable error, and offering "Try again" for one
        // is a trap: `getAccessToken` still sees a locally-unexpired token
        // and hands back the same rejected one, so the button can be
        // pressed forever. Reachable whenever the server rejects a token
        // the client still believes in — a revoked session, clock skew
        // wider than the 30s margin, an audience or issuer mismatch.
        if (error instanceof ApiError && error.status === 401) {
          signOut('session_expired');
          return;
        }
        setState({ status: 'error' });
      });

    // Invalidating the ticket is what guarantees correctness; a superseded
    // request still completes and its result is discarded.
    //
    // Not aborted, because the generated client takes no `AbortSignal` —
    // `packages/core/src/api-client` is generated from the OpenAPI document
    // and never hand-edited (ADR-0007), so adding one is a change to
    // `apps/api/scripts/generate-api-client.cjs`. Worth doing (it would save
    // bandwidth on a slow LAN, which is exactly where this race is
    // reachable), but it is a generator change rather than an app one, and
    // the data-correctness half does not depend on it.
    return () => {
      requestTicket.current += 1;
    };
  }, [apiClient, isoDate, reloadNonce, signOut]);

  const load = useCallback(() => setReloadNonce((n) => n + 1), []);

  const targetSystem = unitsForMeasurementSystem(displaySystem);

  // Computed once. `toDisplayOutputEntries` was called twice per render —
  // once for the chart, once for the table — converting and sorting the
  // same day twice over.
  const observations = state.status === 'loaded' ? state.observations : undefined;
  const entries = useMemo(
    () => (observations ? toDisplayOutputEntries(observations, targetSystem) : []),
    [observations, targetSystem],
  );

  return (
    <>
      {/*
        Sign-out lives in a banner ABOVE `<main>`, not inside it.
        
        It was the first control in the main region, so every keyboard and
        screen-reader user who followed the skip link — the users the skip
        link exists for — landed one Tab press from ending their session,
        before reaching any of the day's data. Tab order follows the DOM, so
        the fix is structural rather than a `tabindex`: a site-wide control
        belongs in the banner landmark, and `<main>` starts at the content
        the page is about.
      */}
      <header>
        <Button variant="secondary" onClick={() => signOut()}>
          {t('auth.signOutButton')}
        </Button>
      </header>

      <main id="main-content" tabIndex={-1}>
        <h1>{t('physicianView.heading')}</h1>
        <p>{t('physicianView.intro')}</p>

        <DateNav isoDate={isoDate} onChangeDate={setIsoDate} />
        <UnitToggle value={displaySystem} onChange={setDisplaySystem} />

        <DailyBalanceNotice />

        {/*
          ONE region, mounted for every state (WCAG 4.1.3).
          
          The loading paragraph used to be conditionally mounted, so the
          announcement stopped at "Loading…": the region was removed from the
          DOM and the chart, heading and table appeared with nothing
          announced and focus unmoved, still on "Show the previous day". A
          screen-reader user pressed previous-day, heard the loading message,
          then silence — with no way to know the load had finished, and every
          chance of reading the previous day's rows under the new day's date.
          Changing the day is the primary interaction on this page.
        */}
        <p role="status" aria-live="polite">
          {state.status === 'loading' ? t('physicianView.loading') : null}
          {state.status === 'loaded'
            ? t('physicianView.loadedStatus', {
                count: state.observations.length,
                date: formatDateTime(new Date(`${isoDate}T00:00:00.000Z`), undefined, {
                  dateStyle: 'long',
                  timeStyle: undefined,
                }),
              })
            : null}
        </p>

        {state.status === 'error' ? (
          <InlineNotice variant="error" icon={<NoticeIcon />} live="assertive">
            <p>{t('physicianView.loadError')}</p>
            <Button variant="secondary" onClick={load}>
              {t('physicianView.retryButton')}
            </Button>
          </InlineNotice>
        ) : null}

        {state.status === 'loaded' && state.observations.length === 0 ? (
          <InlineNotice variant="info" title={t('physicianView.emptyState.heading')}>
            <p>{t('physicianView.emptyState.body')}</p>
          </InlineNotice>
        ) : null}

        {state.status === 'loaded' && state.observations.length > 0 ? (
          <>
            {state.truncated ? (
              <InlineNotice
                variant="warning"
                icon={<NoticeIcon />}
                title={t('physicianView.truncated.heading')}
                live="polite"
              >
                <p>{t('physicianView.truncated.body', { limit: DAILY_PAGE_SIZE })}</p>
              </InlineNotice>
            ) : null}
            <OutputChart entries={entries} />
            <h2>{t('physicianView.table.heading')}</h2>
            <OutputTable
              entries={entries}
              total={toDisplayDailyTotal(state.observations, targetSystem)}
            />
          </>
        ) : null}
      </main>
    </>
  );
}
