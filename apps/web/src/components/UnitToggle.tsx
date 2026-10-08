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

import type { MeasurementSystem } from '@ostomy/core/units';
import { ToggleGroup } from '@ostomy/ui';
import { useTranslation } from 'react-i18next';

export interface UnitToggleProps {
  readonly value: MeasurementSystem;
  readonly onChange: (value: MeasurementSystem) => void;
}

/**
 * A display-only metric/imperial switch for this page.
 *
 * Since P4.S1 slice 4 it **opens on the patient's persisted measurement system**,
 * read from `GET /api/v1/profile` — before that there was nothing to read it
 * from, so it started on metric for everyone and an imperial patient's first
 * figure was in units they had not chosen.
 *
 * Changing it is still local view state and persists nothing: it never rewrites
 * any stored value, only how this screen renders the canonical mL figures it
 * already has. Writing a changed preference back is SRS §3.10's profile edit,
 * which is P4.S3 — and `physicianView.unitsHint` says so to the reader, because
 * a clinician can reasonably read a unit switch as changing what was recorded.
 */
export function UnitToggle({ value, onChange }: UnitToggleProps) {
  const { t } = useTranslation();

  return (
    <ToggleGroup<MeasurementSystem>
      name="display-units"
      legend={t('physicianView.unitsLabel')}
      hint={t('physicianView.unitsHint')}
      value={value}
      onChange={onChange}
      options={[
        { value: 'metric', label: t('physicianView.unitsMetric') },
        { value: 'imperial', label: t('physicianView.unitsImperial') },
      ]}
    />
  );
}
