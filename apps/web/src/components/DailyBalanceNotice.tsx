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

import { InlineNotice, NoticeIcon } from '@ostomy/ui';
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
    <InlineNotice
      variant="warning"
      icon={<NoticeIcon />}
      title={t('physicianView.netBalance.heading')}
    >
      <p>{t('physicianView.netBalance.body')}</p>
    </InlineNotice>
  );
}
