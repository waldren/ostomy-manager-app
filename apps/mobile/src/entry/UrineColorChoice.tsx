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

/**
 * The pale-to-dark urine colour scale (SRS §3.7, AC 12.1 AC3).
 *
 * Shared by the Add Urine screen and the correction inbox rather than
 * duplicated: the inbox has to be able to correct a colour-only entry, and
 * two copies of an accessibility-critical control is two places for the
 * text labels below to fall out of step.
 *
 * ## AC 12.1 AC3 is an accessibility requirement, not a styling one
 *
 * "Each colour step has a visible text label and is announced
 * distinguishably by a screen reader." Both halves are load-bearing here:
 *
 * - The **words** are the scale. Every step carries a catalog label
 *   ("Almost clear", "Pale yellow", ...) that differs from every other, so
 *   a screen reader announces six distinguishable options, and a
 *   colour-blind or low-vision patient reads the same six distinctions a
 *   sighted one sees. This satisfies WCAG 1.4.1 (Use of Color) outright:
 *   colour is never the sole carrier of the information.
 * - The **swatch** is decorative and says so to assistive technology
 *   (`ChoiceGroup` marks it `accessible={false}` and
 *   `importantForAccessibility="no"`). It adds nothing a screen reader
 *   could announce — announcing "#f2de6a" or "yellow swatch" after the
 *   label would be duplication, not information.
 *
 * ## A member with no swatch still renders
 *
 * The value set is admin-managed and members can be added after this
 * release ships (CLAUDE.md), so a code with no token here is reachable. It
 * renders as a label with no swatch rather than being hidden or given an
 * invented colour: a step missing from the scale would misrepresent the
 * scale, and a guessed colour would misrepresent the step.
 */

import { tokens } from '@ostomy/ui';
import { useTranslation } from 'react-i18next';

import { BodyText } from '../ui/BodyText';
import { ChoiceGroup, type Choice } from '../ui/ChoiceGroup';

import { labelKeyFor, type ValueSetOptionsState } from './useValueSetOptions';

/** The i18n namespace the colour labels live under (`urineColor.<code>`). */
const URINE_COLOR_LABEL_NAMESPACE = 'urineColor';

const SWATCHES: Readonly<Record<string, string>> = tokens.urineColorSwatch;

export interface UrineColorChoiceProps {
  readonly options: ValueSetOptionsState;
  readonly value: string | undefined;
  readonly onChange: (code: string) => void;
}

export function UrineColorChoice({
  options,
  value,
  onChange,
}: UrineColorChoiceProps): React.JSX.Element | null {
  const { t } = useTranslation(['common']);

  if (options.status === 'loading') return null;
  if (options.status === 'unavailable') {
    // Says what is true instead of rendering an empty scale. The amount
    // field is still there, so the entry is not blocked — only the
    // colour-without-volume route is, and a patient who cannot use it needs
    // to know that rather than tap at nothing.
    return <BodyText tone="muted">{t('common:entry.optionsUnavailable')}</BodyText>;
  }

  const choices: readonly Choice<string>[] = options.members.map((member) => {
    const key = labelKeyFor(URINE_COLOR_LABEL_NAMESPACE, member.code);
    return {
      value: member.code,
      label: key === undefined ? t('common:entry.unknownOptionLabel') : t(key),
      swatchColor: SWATCHES[member.code],
    };
  });

  return (
    <ChoiceGroup<string>
      label={t('common:entry.urineColorLabel')}
      hint={t('common:entry.urineColorHint')}
      value={value}
      onChange={onChange}
      choices={choices}
    />
  );
}
