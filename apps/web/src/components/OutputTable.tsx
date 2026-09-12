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

import { formatDateTime, formatVolumeQuantity } from '@ostomy/core/i18n';
import type { DisplayVolume } from '@ostomy/core/units';
import { useTranslation } from 'react-i18next';

import type { DisplayOutputEntry } from '../format/formatObservationsForDisplay.js';
import { MethodBadge } from './MethodBadge.js';

export interface OutputTableProps {
  readonly entries: readonly DisplayOutputEntry[];
  readonly total: DisplayVolume;
}

/**
 * The chronological table of the day's stoma output — this IS the table
 * equivalent the accompanying chart (`OutputChart`) needs, so a
 * screen-reader user gets the same information a sighted user reads off
 * the chart (CLAUDE.md "Charts and data display").
 */
export function OutputTable({ entries, total }: OutputTableProps) {
  const { t } = useTranslation();

  return (
    <table>
      <caption>{t('physicianView.table.caption')}</caption>
      <thead>
        <tr>
          <th scope="col">{t('physicianView.table.columnTime')}</th>
          <th scope="col">{t('physicianView.table.columnVolume')}</th>
          <th scope="col">{t('physicianView.table.columnMethod')}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((entry) => (
          <tr key={entry.id}>
            <th scope="row">
              <time dateTime={entry.effectiveDateTime.toISOString()}>
                {formatDateTime(entry.effectiveDateTime)}
              </time>
            </th>
            <td>{formatVolumeQuantity(entry.display)}</td>
            <td>
              <MethodBadge method={entry.method} />
            </td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">{t('physicianView.table.totalRowLabel')}</th>
          <td>{formatVolumeQuantity(total)}</td>
          <td />
        </tr>
      </tfoot>
    </table>
  );
}
