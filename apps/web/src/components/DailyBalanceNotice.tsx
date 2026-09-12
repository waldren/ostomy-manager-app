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

import { InlineNotice } from '@ostomy/ui';
import { useTranslation } from 'react-i18next';

/**
 * Daily Net Fluid Balance needs BOTH fluid intake and stoma output
 * (SRS §3.5). Fluid intake logging does not exist yet (it lands at P3), so
 * this renders an explicit, explained empty state rather than a number —
 * a plausible-looking balance figure computed from output alone would be
 * clinically wrong and could be trusted by a physician reading this page.
 */
export function DailyBalanceNotice() {
  const { t } = useTranslation();

  return (
    // `info`, not `warning`, and no caution icon.
    //
    // This is an availability note about the PRODUCT, not a warning about
    // the patient. SRS §5.4 requires the red-flag prompt to be visually and
    // verbally separate from ordinary nudges and data-quality warnings, and
    // the failure it guards against is teaching a reader that the urgent
    // voice and the routine voice look alike. This sprint is the first UI in
    // the product, so it sets that vocabulary — spending the caution
    // triangle and the warning border on a feature that does not exist yet
    // devalues both before P7's red flags ever ship.
    <InlineNotice variant="info" title={t('physicianView.netBalance.heading')}>
      <p>{t('physicianView.netBalance.body')}</p>
    </InlineNotice>
  );
}
