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
import { useProfile } from '../profile/useProfile.js';
import { useRanges } from '../ranges/useRanges.js';
import { TargetRanges } from '../components/TargetRanges.js';
import { UrineSignalNotice } from '../components/UrineSignalNotice.js';
import {
  toDisplayDailyTotal,
  toDisplayOutputEntries,
  observationsOnLocalDate,
  isFluidBalanceIntake,
  isFluidBalanceOutput,
  toDisplayNetFluidBalance,
  toUrineDaySummary,
  hasFluidBalanceInputs,
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

/**
 * A window wide enough to contain the requested PATIENT-LOCAL day, whatever
 * zone it was entered in (ADR-0016).
 *
 * A local day is not a UTC day. UTC+14 and UTC-12 both exist, so an entry
 * filed under local `isoDate` can carry an instant anywhere from 10:00 the
 * previous UTC day to 12:00 the following one. Asking for the UTC day alone
 * — which this page used to do — silently drops a Chicago patient's whole
 * evening from their total and files it under tomorrow.
 *
 * So the fetch is deliberately over-wide and `observationsOnLocalDate` does
 * the exact selection. Over-fetching costs a larger response; under-fetching
 * costs a wrong clinical figure with nothing on screen to suggest it.
 */
function localDayFetchWindowUtc(isoDate: string): { from: string; to: string } {
  const from = new Date(`${isoDate}T00:00:00.000Z`);
  from.setUTCDate(from.getUTCDate() - 1);
  const to = new Date(`${isoDate}T23:59:59.999Z`);
  to.setUTCDate(to.getUTCDate() + 1);
  return { from: from.toISOString(), to: to.toISOString() };
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The physician view (SRS §3.5): one patient-local day of stoma output, plus
 * Daily Net Fluid Balance.
 *
 * The balance is rendered rather than explained-away as of P3.S1b. It needed
 * two things that did not exist when this page shipped: fluid intake logging
 * (P3.S1), and a `GET /api/v1/observations` that returns more than stoma
 * output — the figure is intake MINUS output, so a single-code response
 * cannot produce it.
 *
 * **The day is the patient's local day** (ADR-0016), not a UTC one. The fetch
 * window is deliberately wider than the day and `observationsOnLocalDate`
 * makes the exact selection, because a local day can straddle two UTC days in
 * either direction. Everything below — chart, table, total, balance — reads
 * from that one selection, so they cannot disagree about which day they
 * describe.
 *
 * This is emphatically not the patient dashboard (SRS §3.12): there is no
 * composite status here, and there will not be one even once the other
 * three hydration signals exist — this view keeps them separate and
 * uncombined, always.
 *
 * **Volumes open in the patient's own measurement system** (P4.S1 slice 4).
 * Until onboarding existed there was nothing to read it from, so the toggle
 * started on metric for everyone — which for an imperial patient meant the first
 * figure they saw was in units they had not chosen. The toggle remains a
 * display-only override; persisting a change to it is P4.S3's preference edit.
 *
 * Nothing clinical renders until the system is known. This app is online-only by
 * explicit decision, so a failed profile fetch is a failure to KNOW rather than
 * something a cache can cover, and "350" read as ounces instead of millilitres is
 * a sevenfold misreading of a clinical value.
 */
export function PhysicianOutputView() {
  const { t } = useTranslation();
  const { getAccessToken, signOut } = useAuth();
  const apiClient = useMemo(() => createWebApiClient(getAccessToken), [getAccessToken]);

  const [isoDate, setIsoDate] = useState(todayIsoDate);
  /**
   * `undefined` means "whatever the patient's preference is", and it is what the
   * page starts on.
   *
   * Deliberately not seeded from the profile by an effect: the profile arrives
   * after the first paint, and a seeding effect would overwrite the choice of a
   * patient who had already touched the toggle. Touching it is what makes the
   * value explicit, and from then on it wins.
   */
  const [chosenSystem, setChosenSystem] = useState<MeasurementSystem | undefined>(undefined);
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
    const { from, to } = localDayFetchWindowUtc(isoDate);

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

  /**
   * The 401 response is the same here as for the observations fetch, and for the
   * same reason: `getAccessToken` would hand back the token the server just
   * rejected, so a retry button could be pressed forever.
   */
  const onUnauthenticated = useCallback(() => signOut('session_expired'), [signOut]);
  const profileState = useProfile({ apiClient, onUnauthenticated });
  /**
   * Fetched beside the profile, not inside the day's effect: a target range does
   * not vary with the date on screen, so refetching it on every press of
   * "previous day" would be work for nothing.
   */
  const rangesState = useRanges({ apiClient, onUnauthenticated });

  const profileSystem =
    profileState.status === 'loaded' ? profileState.profile.measurementSystem : undefined;
  const displaySystem = chosenSystem ?? profileSystem;

  /**
   * `undefined` until the system is known, which is what the render gates on.
   *
   * A fallback to metric here would be the defect P4.S1 slice 3 removed from the
   * entry screens, in its read-only form: an imperial patient reading "2366"
   * where they expect "80". It is visible rather than silent — the toggle and the
   * axis both name the unit — but a figure in the wrong system is still a figure a
   * clinician may act on before noticing the label.
   */
  const targetSystem =
    displaySystem === undefined ? undefined : unitsForMeasurementSystem(displaySystem);

  // Computed once. `toDisplayOutputEntries` was called twice per render —
  // once for the chart, once for the table — converting and sorting the
  // same day twice over.
  const fetched = state.status === 'loaded' ? state.observations : undefined;

  // The requested LOCAL day, selected from the deliberately over-wide fetch
  // window. Everything below reads from this, so the chart, the table, the
  // total and the balance cannot disagree about which day they describe.
  const selection = useMemo(
    () => (fetched ? observationsOnLocalDate(fetched, isoDate) : { onDate: [], undatable: 0 }),
    [fetched, isoDate],
  );
  const observations = selection.onDate;

  // The chart and table remain stoma output. `GET /api/v1/observations` now
  // returns intake as well — which is what makes the balance computable —
  // and rendering both in one undifferentiated timeline would present a
  // drink and an emptying as the same kind of event.
  const outputObservations = useMemo(
    () => observations.filter(isFluidBalanceOutput),
    [observations],
  );

  /**
   * Everything rendered in a unit, computed together, and `undefined` until the
   * patient's measurement system is known.
   *
   * One memo rather than four, because they must agree: a page showing a chart in
   * millilitres beside a balance in ounces would be worse than showing neither.
   * And `undefined` rather than a metric fallback, because this page has already
   * been bitten by a well-formed figure nobody asserted — see the note below on
   * `toDisplayDailyTotal([])` returning `0 mL` for a day with no output.
   *
   * The second hydration signal is kept beside the balance and out of it (SRS
   * §3.7): `toDisplayNetFluidBalance` is handed the SAME undifferentiated
   * `observations` and excludes urine by LOINC code in `packages/core`, so the
   * separation is one rule in one place rather than a filter each caller has to
   * remember.
   */
  const view = useMemo(() => {
    if (targetSystem === undefined) return undefined;
    return {
      entries: toDisplayOutputEntries(outputObservations, targetSystem),
      balance: hasFluidBalanceInputs(observations)
        ? toDisplayNetFluidBalance(observations, targetSystem)
        : undefined,
      urine: toUrineDaySummary(observations, targetSystem),
      total: toDisplayDailyTotal(outputObservations, targetSystem),
    };
  }, [observations, outputObservations, targetSystem]);

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

        {/*
          Only once the patient's system is known, so the control never shows a
          selection the patient did not make. It opens on their own preference and
          changing it is a local override — the hint says as much.
        */}
        {displaySystem === undefined ? null : (
          <UnitToggle value={displaySystem} onChange={setChosenSystem} />
        )}

        {/*
          No profile at all. Not an error and not fixable here: onboarding is in
          the mobile app (ADR-0020), so this says what to do rather than offering
          a "try again" for a condition that does not resolve by trying — the trap
          #80 recorded on the mobile dashboard, in this app's version.
        */}
        {profileState.status === 'not-provisioned' ? (
          <InlineNotice
            variant="info"
            title={t('common:notProvisioned.heading', { ns: 'common' })}
            live="polite"
          >
            <p>{t('physicianView.notProvisionedBody')}</p>
          </InlineNotice>
        ) : null}

        {profileState.status === 'error' ? (
          <InlineNotice variant="error" icon={<NoticeIcon />} live="assertive">
            <p>{t('physicianView.profileLoadError')}</p>
          </InlineNotice>
        ) : null}

        {/*
          Below the day's data and gated on the same known measurement system.
          A range rendered in units the patient did not choose is the defect
          P4.S1 slice 3 removed from the entry screens, and showing "600 mL to
          1500 mL" to an imperial reader would reintroduce it here.

          A failed fetch renders nothing rather than taking the page down: the
          chart, table and balance do not depend on a target range, and removing
          the clinical view because a secondary read failed is the wrong trade.
        */}
        {targetSystem !== undefined && rangesState.status === 'loaded' ? (
          <TargetRanges ranges={rangesState.ranges} targetSystem={targetSystem} />
        ) : null}

        {view === undefined ? null : (
          <>
            <DailyBalanceNotice
              balance={view.balance}
              hasIntake={observations.some(isFluidBalanceIntake)}
              hasOutput={observations.some(isFluidBalanceOutput)}
            />

            <UrineSignalNotice summary={view.urine} />
          </>
        )}

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
                count: observations.length,
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

        {state.status === 'loaded' && view !== undefined && observations.length === 0 ? (
          <InlineNotice variant="info" title={t('physicianView.emptyState.heading')}>
            <p>{t('physicianView.emptyState.body')}</p>
          </InlineNotice>
        ) : null}

        {state.status === 'loaded' && view !== undefined && observations.length > 0 ? (
          <>
            {selection.undatable > 0 ? (
              <InlineNotice
                variant="warning"
                icon={<NoticeIcon />}
                title={t('physicianView.undatable.heading')}
                live="polite"
              >
                <p>{t('physicianView.undatable.body', { count: selection.undatable })}</p>
              </InlineNotice>
            ) : null}
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
            {/*
              Gated on the OUTPUT rows, not on the day's rows.

              A day holding only urine entries passes the
              `observations.length === 0` empty state above, and then rendered
              an empty chart, an empty table, and — because
              `toDisplayDailyTotal([])` returns a well-formed zero — **0 mL as
              the day's stoma output**. That is a clinical claim nobody made,
              and it is the same defect `volumeMlOf` exists to prevent,
              mirrored: this sprint is what made a urine-only day an ordinary
              case rather than a curiosity.
            */}
            {view.entries.length === 0 ? (
              <>
                <h2>{t('physicianView.table.heading')}</h2>
                <p>{t('physicianView.table.noOutput')}</p>
              </>
            ) : (
              <>
                {/*
                  The heading stays BETWEEN the chart and the table.

                  Hoisting it above the chart to cover the empty message put it
                  immediately before `OutputChart`'s own `h2` — two sibling
                  headings about stoma output, the first promising "entries" and
                  landing a reader on a chart, with the table it names two
                  headings further down. Heading navigation is how a clinician
                  skims this page; un-associating a heading from its content is
                  the same defect as having no heading at all, which is what the
                  urine and balance regions were fixed for in this same change.
                */}
                <OutputChart entries={view.entries} />
                <h2>{t('physicianView.table.heading')}</h2>
                <OutputTable entries={view.entries} total={view.total} />
              </>
            )}
          </>
        ) : null}
      </main>
    </>
  );
}
