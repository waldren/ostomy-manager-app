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

import { formatVolumeQuantity } from '@ostomy/core/i18n';
import { InlineNotice } from '@ostomy/ui';
import { useTranslation } from 'react-i18next';

import type { DisplayVolume } from '@ostomy/core/units';

export interface DailyBalanceProps {
  /** Signed: intake minus output, already converted and rounded once. `undefined` when the day has neither. */
  readonly balance: DisplayVolume | undefined;
  readonly hasIntake: boolean;
  readonly hasOutput: boolean;
}

/**
 * Daily Net Fluid Balance (SRS §3.5).
 *
 * This component used to render an explained empty state saying the figure
 * could not be shown because fluid intake logging did not exist. It does now
 * (P3.S1), so it shows the number.
 *
 * ## Why a one-sided day still gets a caveat rather than a bare figure
 *
 * A "balance" computed from output alone is not a balance, and it fails in
 * the dangerous direction: a day of stoma output with no intake logged
 * produces a large negative number that reads as a severe deficit, when it
 * may only be an unlogged one. The same holds mirrored for intake without
 * output. So the figure is still shown — withholding it would be its own
 * kind of lie about a day that does have data — but it is labelled for what
 * it is.
 *
 * ## Why urine is named unprompted
 *
 * Voided urine is excluded from this figure on purpose (SRS §3.7): net
 * balance measures stoma losses, while urine output independently signals
 * renal perfusion. A reader who assumes urine is included reads a
 * reassuring balance while urine output may be dangerously low. That
 * assumption is invisible unless the page states it, so it does.
 *
 * ## Why no colour, icon, or verdict
 *
 * `info`, never `warning`, whatever the sign. SRS §5.4 reserves the urgent
 * voice for the red-flag prompt, and a negative balance is an ordinary and
 * expected reading for this population — dressing it as a warning teaches a
 * reader that the urgent voice is routine, which is what makes a real red
 * flag ignorable. This is also a physician's view, which keeps the four
 * hydration signals separate and uncombined: interpretation is the reader's.
 */
export function DailyBalanceNotice({ balance, hasIntake, hasOutput }: DailyBalanceProps) {
  const { t } = useTranslation();

  if (balance === undefined) {
    return (
      <InlineNotice variant="info" title={t('physicianView.netBalance.heading')}>
        <p>{t('physicianView.netBalance.noInputs')}</p>
      </InlineNotice>
    );
  }

  return (
    <InlineNotice variant="info" title={t('physicianView.netBalance.heading')}>
      {/*
        The figure is a `<p>`, not a heading or a bare string, and carries the
        formatted sign from `Intl` rather than a hand-assembled "-" — a
        minus-hyphen and a real minus differ in how a screen reader says them,
        and "minus 400 millilitres" is the reading that matters here.
      */}
      <p>{t('physicianView.netBalance.value', { amount: formatVolumeQuantity(balance) })}</p>
      <p>{t('physicianView.netBalance.explanation')}</p>
      {!hasIntake ? <p>{t('physicianView.netBalance.intakeMissing')}</p> : null}
      {!hasOutput ? <p>{t('physicianView.netBalance.outputMissing')}</p> : null}
      <p>{t('physicianView.netBalance.excludesUrine')}</p>
    </InlineNotice>
  );
}
