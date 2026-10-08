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

import { Redirect, router, useLocalSearchParams } from 'expo-router';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, View } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import type { LocalProfile } from '../src/db/repositories/profileRepository';
import { OnboardingForm } from '../src/onboarding/OnboardingForm';
import { useProfileState } from '../src/onboarding/ProfileProvider';
import { BodyText } from '../src/ui/BodyText';
import { Button } from '../src/ui/Button';
import { Heading } from '../src/ui/Heading';
import { Screen } from '../src/ui/Screen';

/**
 * The onboarding route: which of three screens a patient who is not yet set up sees.
 *
 * The three questions themselves are `OnboardingForm`. This file decides whether to
 * ask them at all, and that decision is the interesting half.
 *
 * ## The gate's `unreachable` state does NOT get the questions
 *
 * A device with no local profile is not evidence of a new patient — a reinstall, a
 * new phone, or a store destroyed by a different subject signing in (ADR-0014) all
 * produce it for someone who onboarded months ago. So when the gate could not reach
 * the server, this shows a connection notice with a retry instead. Asking the
 * questions there would walk a provisioned patient through a form whose submit can
 * only answer 409, and invite them to re-state a surgery date that is already
 * recorded.
 *
 * ## `?again=1` — the one way a provisioned patient reaches this screen
 *
 * Normally a patient with a profile is redirected away: there is nothing to ask. But
 * the sync worker can report `PATIENT_NOT_PROVISIONED` while this device still holds
 * a profile — a development reset, or an ADR-0017 purge — and the dashboard then
 * offers a route back here. Without the parameter that route would bounce straight
 * back to the dashboard, so the patient would tap a button that did nothing.
 *
 * Arriving that way pre-fills every answer from the local row, because the patient
 * has already answered these questions once and retyping a surgery date they gave
 * months ago is both tedious and a chance to get it wrong.
 */
export default function Onboarding(): React.JSX.Element {
  const { phase } = useAuth();
  const { t } = useTranslation(['common', 'mobile']);
  const { state, refresh, adopt, port } = useProfileState();
  const params = useLocalSearchParams<{ again?: string }>();
  const reOnboarding = params.again === '1';

  const onProvisioned = useCallback(
    async (profile: LocalProfile) => {
      // `adopt` writes the row before the gate opens, so the dashboard this navigates
      // to reads a profile that is already there.
      await adopt(profile);
      router.replace('/home');
    },
    [adopt],
  );

  if (phase !== 'authenticated') return <Redirect href="/login" />;

  // A patient who already has a profile has no business here — reachable by a back
  // gesture after finishing. `?again=1` is the exception: the server has lost a
  // profile this device still holds, and re-provisioning is the whole point.
  if (state.status === 'present' && !reOnboarding) return <Redirect href="/home" />;

  if (state.status === 'checking') {
    return (
      <Screen>
        {/* Hidden from assistive technology; the text carries the name, so VoiceOver
            does not read the same string twice. */}
        <ActivityIndicator accessible={false} importantForAccessibility="no" />
        <BodyText>{t('common:onboarding.checkingLabel')}</BodyText>
      </Screen>
    );
  }

  if (state.status === 'unreachable') {
    return (
      <Screen>
        <View accessibilityLiveRegion="polite">
          <Heading>{t('common:onboarding.unreachableHeading')}</Heading>
          <BodyText>{t('common:onboarding.unreachableBody')}</BodyText>
        </View>
        <Button
          label={t('common:onboarding.retryButton')}
          onPress={() => {
            void refresh();
          }}
        />
      </Screen>
    );
  }

  /**
   * Mounted only now, with the gate settled.
   *
   * That ordering is load-bearing rather than tidy: the form seeds its fields in
   * `useState` initialisers, which run once, so a form mounted while the gate was
   * still checking would seed from a profile that had not arrived and keep the blanks.
   */
  return (
    <Screen>
      <OnboardingForm
        port={port}
        onProvisioned={onProvisioned}
        {...(reOnboarding && state.status === 'present' ? { prefill: state.profile } : {})}
      />
    </Screen>
  );
}
