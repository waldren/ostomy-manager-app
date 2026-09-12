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

import { Button, TextField, VisuallyHidden } from '@ostomy/ui';
import { useTranslation } from 'react-i18next';

export interface DateNavProps {
  /** The selected calendar day, in the format `YYYY-MM-DD`. */
  readonly isoDate: string;
  readonly onChangeDate: (isoDate: string) => void;
}

function shiftIsoDate(isoDate: string, deltaDays: number): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Previous/next-day navigation for the physician view. Never allows navigating into the future. */
export function DateNav({ isoDate, onChangeDate }: DateNavProps) {
  const { t } = useTranslation();
  const isToday = isoDate >= todayIsoDate();

  return (
    <nav aria-label={t('physicianView.selectedDate')}>
      <Button variant="secondary" onClick={() => onChangeDate(shiftIsoDate(isoDate, -1))}>
        {t('physicianView.previousDay')}
      </Button>
      {/*
        `TextField`, not a bare <input>. This was a hand-rolled
        label-wrapping-input with no classes at all, so it took the browser's
        default control: no 44px minimum target (a requirement here, not
        polish — the patient population skews older and post-surgical), no
        shared two-tone focus ring, and a border that matched nothing else on
        the page. A date input is still a form field, and the reason
        `packages/ui` owns field chrome is so no screen has to remember any
        of that.
      */}
      <TextField
        id="date-nav-selected-date"
        label={t('physicianView.selectedDate')}
        type="date"
        value={isoDate}
        max={todayIsoDate()}
        onChange={(event) => {
          if (event.target.value) {
            onChangeDate(event.target.value);
          }
        }}
      />
      <Button
        variant="secondary"
        onClick={() => {
          if (!isToday) {
            onChangeDate(shiftIsoDate(isoDate, 1));
          }
        }}
        aria-disabled={isToday}
        aria-describedby={isToday ? 'date-nav-next-disabled-hint' : undefined}
      >
        {t('physicianView.nextDay')}
      </Button>
      {isToday ? (
        <VisuallyHidden>
          <span id="date-nav-next-disabled-hint">{t('physicianView.nextDayDisabledHint')}</span>
        </VisuallyHidden>
      ) : null}
    </nav>
  );
}
