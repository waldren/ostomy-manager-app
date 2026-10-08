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

import { Redirect } from 'expo-router';
import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from 'react-native';

import type { LocalProfile } from '../db/repositories/profileRepository';
import { BodyText } from '../ui/BodyText';
import { Screen } from '../ui/Screen';

import { useProfileState } from './ProfileProvider';

/**
 * Wraps a screen that cannot function without the patient's profile (P4.S1
 * slice 3).
 *
 * ## Why a wrapper and not a defaulted value
 *
 * Every screen under here reads two profile fields, and a fallback for either is
 * worse than not rendering:
 *
 * - **`measurementSystem`** decides what every amount is rendered AND recorded
 *   as. ADR-0012 makes `entered_measurement_system` the client's assertion about
 *   what the patient typed, `NOT NULL` with no default, and permanent per row —
 *   "no later migration can recover the truth if it is stored wrongly". A
 *   fallback to `metric` would show an imperial patient millilitres and then
 *   write metric provenance onto their entry.
 * - **`surgeryDate`** is the Tier 1 lower bound. Absent, it does not block
 *   anything, so the rule silently stops applying — the failure mode
 *   `validation_thresholds_cache` is deliberately unseeded to avoid: "a default
 *   there is a hardcoded threshold wearing a database costume".
 *
 * So the profile arrives as a required prop, and the type system is what enforces
 * it. `DEFAULT_MEASUREMENT_SYSTEM` is deleted rather than left unused: a constant
 * that still exists is one the next screen can reach for.
 *
 * ## A wrapper rather than an early return inside each screen
 *
 * The entry hooks need the profile's values as arguments, so they would have to
 * be called before any early return — which means a screen checking for itself
 * would still have to hand its hooks *something* for the case it is about to
 * redirect away from. Making the profile a prop removes that branch entirely:
 * there is no value to invent, because the component does not run without one.
 *
 * ## Where it sends a patient with no profile
 *
 * To onboarding, which is the only thing they can usefully do. That is reachable
 * in practice rather than defensive: a deep link, or a back gesture after a
 * sign-out and a fresh sign-in on a device whose store was destroyed by a
 * different subject (ADR-0014).
 */
export function withProfile(
  ScreenComponent: ComponentType<{ readonly profile: LocalProfile }>,
): () => React.JSX.Element {
  function ProfileGatedScreen(): React.JSX.Element {
    const { state } = useProfileState();
    const { t } = useTranslation('mobile');

    if (state.status === 'checking') {
      return (
        <Screen>
          {/* Hidden from assistive technology; the text carries the name, so a
              screen reader does not read the same string twice. */}
          <ActivityIndicator accessible={false} importantForAccessibility="no" />
          <BodyText>{t('common.loadingLabel')}</BodyText>
        </Screen>
      );
    }

    if (state.status !== 'present') return <Redirect href="/onboarding" />;

    return <ScreenComponent profile={state.profile} />;
  }

  return ProfileGatedScreen;
}
