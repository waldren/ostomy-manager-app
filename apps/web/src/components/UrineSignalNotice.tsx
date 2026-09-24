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

import { en, formatVolumeQuantity } from '@ostomy/core/i18n';
import { InlineNotice } from '@ostomy/ui';
import { useTranslation } from 'react-i18next';

import type { UrineDaySummary } from '../format/formatObservationsForDisplay.js';

export interface UrineSignalNoticeProps {
  /** `undefined` when the day holds no voided-urine entries at all. */
  readonly summary: UrineDaySummary | undefined;
}

/**
 * The catalog key for a `urine_color` member's label, or `undefined` when
 * this release has no copy for it.
 *
 * Checks the catalog itself rather than carrying a list of known codes. The
 * value set is admin-managed and members can be added after a release ships
 * (CLAUDE.md), so a code with no label is a reachable state — and rendering
 * `dark_yellow` at a reader would be worse than saying plainly that it is one
 * this build does not know. `apps/mobile`'s `labelKeyFor` does the same thing
 * for the same reason; the two are not shared because they resolve into
 * different namespaces, and neither app may import the other.
 */
function urineColorLabelKey(code: string): string | undefined {
  const key = `urineColor.${code}`;
  return Object.prototype.hasOwnProperty.call(en.common, key) ? `common:${key}` : undefined;
}

/**
 * Urine output, the second hydration signal (SRS §3.7, AC 12.1).
 *
 * ## Why this is a separate block and not a line inside the balance
 *
 * Because merging them is the one thing CLAUDE.md names outright about this
 * data: net balance measures stoma losses, urine output independently signals
 * renal perfusion, and summing them lets a normal-looking balance hide a
 * dangerously low urine output. `DailyBalanceNotice` already says urine is
 * excluded; this says the same thing from this side, so a reader arriving
 * here first does not have to find the other block to learn it.
 *
 * Adjacent to the balance rather than elsewhere on the page, because a
 * clinician comparing the two is exactly the intended reading — which is
 * different from the page computing the comparison for them. It does not:
 * this is a physician's view, and SRS §3.12's composite status is the
 * patient dashboard's job, not this one's.
 *
 * ## Why a day can be all colours and no number
 *
 * AC 12.1 AC2. A patient who cannot measure records a colour alone, and that
 * entry is a real hydration observation rather than a gap in the data. So the
 * measured total is reported with HOW MUCH OF THE DAY IT COVERS, and a day
 * with no measurement at all says so plainly instead of rendering "0 mL" —
 * which would be a clinical claim nobody made, and the worst possible one to
 * invent for this signal.
 *
 * ## Why no threshold and no verdict
 *
 * `info`, never `warning`. SRS §5.4 reserves the urgent voice for the
 * red-flag prompt, and this view keeps the four hydration signals separate
 * and uncombined — interpretation is the reader's.
 */
export function UrineSignalNotice({ summary }: UrineSignalNoticeProps) {
  const { t } = useTranslation();

  // Nothing recorded is not a state worth a block. Unlike the balance — whose
  // absence is itself informative, because a reader expects it every day —
  // a day with no urine entries is the ordinary case for a patient who does
  // not log them, and an empty notice every day is noise that trains a reader
  // to skip the region where a real signal will appear.
  if (summary === undefined) return null;

  const { entryCount, measuredTotal, measuredCount, colorCodes } = summary;

  return (
    <InlineNotice variant="info" title={t('physicianView.urine.heading')}>
      {measuredTotal === undefined ? (
        <p>{t('physicianView.urine.noneMeasured', { count: entryCount })}</p>
      ) : (
        <>
          <p>{t('physicianView.urine.total', { amount: formatVolumeQuantity(measuredTotal) })}</p>
          <p>{t('physicianView.urine.measuredOf', { count: measuredCount, total: entryCount })}</p>
        </>
      )}

      {colorCodes.length > 0 ? (
        <>
          {/*
            A list, not a comma-joined sentence. A screen reader announces
            "list, 3 items" and each shade on its own, which is the reading a
            clinician scanning for "how dark did it get" actually wants; a
            joined string is one long run-on they cannot step through.
          */}
          <p>{t('physicianView.urine.colorsHeading')}</p>
          <ul>
            {colorCodes.map((code) => {
              const key = urineColorLabelKey(code);
              return (
                <li key={code}>
                  {key === undefined ? t('common:entry.unknownOptionLabel') : t(key)}
                </li>
              );
            })}
          </ul>
          <p>{t('physicianView.urine.colorsExplanation')}</p>
        </>
      ) : null}

      <p>{t('physicianView.urine.separateFromBalance')}</p>
    </InlineNotice>
  );
}
