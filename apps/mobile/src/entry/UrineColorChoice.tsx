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
 * - The **words** are the scale. Every step carries a catalog label that
 *   differs from every other, so a screen reader announces six
 *   distinguishable options, and a colour-blind or low-vision patient reads
 *   the same six distinctions a sighted one sees. This satisfies WCAG 1.4.1
 *   (Use of Color) outright: colour is never the sole carrier.
 * - The words also have to be **orderable**, which the first version got
 *   wrong. This is a pale-to-dark scale and its DIRECTION is the clinical
 *   content — darker means more concentrated. Six unique names satisfy
 *   "announced distinguishably" while leaving a screen-reader user unable to
 *   tell which end is which: nothing placed "Amber" against "Dark yellow",
 *   and React Native reports no position-in-set for this control. So the two
 *   ends name themselves as ends, the middle shares one comparative
 *   vocabulary, the group hint states the direction, and each option carries
 *   its step number. Four channels, because a TalkBack user can switch hints
 *   off and the labels must still carry it (WCAG 1.3.1).
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
    // Its OWN string, not the shared `entry.optionsUnavailable` the intake and
    // meal screens use. That one ends "You can still save your entry without
    // them" — true where the picker is genuinely optional, and false here in
    // the one way that matters: with no scale, the colour-without-volume route
    // is gone and a patient who cannot measure can save nothing at all. This
    // comment said as much while the string said the opposite.
    return <BodyText tone="muted">{t('common:entry.urineColorUnavailable')}</BodyText>;
  }

  const total = options.members.length;
  const choices: readonly Choice<string>[] = options.members.map((member, index) => {
    const key = labelKeyFor(URINE_COLOR_LABEL_NAMESPACE, member.code);
    return {
      value: member.code,
      label: key === undefined ? t('common:entry.unknownOptionLabel') : t(key),
      // Position in the scale, announced per option. React Native sets no
      // collection info on a `ChoiceGroup`, so there is no reliable "3 of 6"
      // from the platform — and without it a screen-reader user picking a
      // point on a scale cannot tell how far along it they are.
      //
      // `members` arrives ordered by the value set's `sort_order`
      // (`valueSetsRepository`), which IS the clinical ordering, pale to dark.
      hint: t('common:entry.urineColorStepHint', { step: index + 1, total }),
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
