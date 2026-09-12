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

import type { Observation } from '@ostomy/core/api-client';
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
  | { readonly status: 'loaded'; readonly observations: readonly Observation[] };

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
      .list({ effectiveDateTimeFrom: from, effectiveDateTimeTo: to })
      .then((response) => {
        if (isStale()) return;
        setState({ status: 'loaded', observations: response.observations });
      })
      .catch(() => {
        if (isStale()) return;
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
  }, [apiClient, isoDate, reloadNonce]);

  const load = useCallback(() => setReloadNonce((n) => n + 1), []);

  const targetSystem = unitsForMeasurementSystem(displaySystem);

  return (
    <main id="main-content" tabIndex={-1}>
      <h1>{t('physicianView.heading')}</h1>
      <p>{t('physicianView.intro')}</p>

      <Button variant="secondary" onClick={() => signOut()}>
        {t('auth.signOutButton')}
      </Button>

      <DateNav isoDate={isoDate} onChangeDate={setIsoDate} />
      <UnitToggle value={displaySystem} onChange={setDisplaySystem} />

      <DailyBalanceNotice />

      {state.status === 'loading' ? (
        <p role="status" aria-live="polite">
          {t('physicianView.loading')}
        </p>
      ) : null}

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
          <OutputChart entries={toDisplayOutputEntries(state.observations, targetSystem)} />
          <h2>{t('physicianView.table.heading')}</h2>
          <OutputTable
            entries={toDisplayOutputEntries(state.observations, targetSystem)}
            total={toDisplayDailyTotal(state.observations, targetSystem)}
          />
        </>
      ) : null}
    </main>
  );
}
