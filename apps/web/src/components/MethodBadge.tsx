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

import { Badge, EstimatedIcon, MeasuredIcon } from '@ostomy/ui';
import { useTranslation } from 'react-i18next';

import type { EntryMethod } from '../format/formatObservationsForDisplay.js';

export interface MethodBadgeProps {
  readonly method: EntryMethod;
}

/**
 * The Measured/Estimated indicator required on every output entry in
 * history (AC 2.2 AC2, SRS §7). Renders a distinct icon AND distinct text
 * for each state — never colour alone — using the same `common:method.*`
 * copy the shared i18n catalog defines for this exact distinction
 * (ADR-0006).
 */
export function MethodBadge({ method }: MethodBadgeProps) {
  const { t } = useTranslation('common');

  if (method === 'measured') {
    return (
      <Badge variant="info" icon={<MeasuredIcon />}>
        {t('method.measured')}
      </Badge>
    );
  }

  return (
    <Badge variant="neutral" icon={<EstimatedIcon />}>
      {t('method.estimated')}
    </Badge>
  );
}
