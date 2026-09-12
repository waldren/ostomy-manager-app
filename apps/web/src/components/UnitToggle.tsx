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
 * A display-only metric/imperial switch for this page. `apps/web` has no
 * preferences endpoint yet (that lands with Preference Management, P4), so
 * this is local view state, not the patient's persisted measurement-system
 * preference (SRS §3.10) — it never rewrites any stored value, only how
 * this screen renders the canonical mL figures it already has.
 */
export function UnitToggle({ value, onChange }: UnitToggleProps) {
  const { t } = useTranslation();

  return (
    <ToggleGroup<MeasurementSystem>
      name="display-units"
      legend={t('physicianView.unitsLabel')}
      value={value}
      onChange={onChange}
      options={[
        { value: 'metric', label: t('physicianView.unitsMetric') },
        { value: 'imperial', label: t('physicianView.unitsImperial') },
      ]}
    />
  );
}
