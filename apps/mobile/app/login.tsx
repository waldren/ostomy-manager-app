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
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AccessibilityInfo } from 'react-native';

import { useAuth } from '../src/auth/AuthContext';
import { isBiometricUnlockAvailable } from '../src/auth/biometricUnlock';
import { useOidcLogin } from '../src/auth/useOidcLogin';
import { BodyText } from '../src/ui/BodyText';
import { Button } from '../src/ui/Button';
import { Heading } from '../src/ui/Heading';
import { Screen } from '../src/ui/Screen';

/** What went wrong, so the retry can do the right thing and the copy can say the right thing. */
type LoginFailure = 'signIn' | 'unlock' | 'cancelled' | 'unavailable';

/**
 * One route rendering two states — "signed out" (full OIDC login) and
 * "locked" (biometric unlock of an already-stored session) — rather than
 * a third route. See `src/auth/authPhase.ts` for why these are exactly the
 * two pre-authenticated phases that exist.
 */
export default function Login(): React.JSX.Element {
  const { phase, unlock, completeLogin } = useAuth();
  const { t } = useTranslation('mobile');
  const { isReady, login } = useOidcLogin();
  const [failure, setFailure] = useState<LoginFailure | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [biometricAvailable, setBiometricAvailable] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (phase !== 'locked') return;
    let cancelled = false;
    isBiometricUnlockAvailable().then((available) => {
      if (!cancelled) setBiometricAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  const message = failure ? FAILURE_COPY_KEY[failure] : undefined;

  /*
    Announced explicitly, because `accessibilityLiveRegion` is ANDROID-ONLY.
    iOS VoiceOver ignores it entirely, so a blind patient tapped "Sign in",
    the browser opened and returned, the attempt failed — and nothing was
    said. Focus stayed on the button, and the error renders after it in
    document order, so even swiping forward reached the failed button first.
    They had no way to know it had failed.
  */
  useEffect(() => {
    if (message) AccessibilityInfo.announceForAccessibility(t(message));
  }, [message, t]);

  const handleSignIn = useCallback(async () => {
    setFailure(undefined);
    setBusy(true);
    try {
      const tokens = await login();
      if (tokens) {
        await completeLogin(tokens);
      } else {
        // `login()` resolves undefined when discovery is unavailable or the
        // patient dismissed the browser. Previously this set nothing at
        // all: the button appeared to do nothing, forever, with no error
        // and no announcement, and the patient tapped it repeatedly.
        setFailure(isReady ? 'cancelled' : 'unavailable');
      }
    } catch {
      // Never log the error: it may embed a query string carrying an
      // authorization code or provider-side detail, and this app has no
      // sanctioned diagnostic sink for auth failures.
      setFailure('signIn');
    } finally {
      setBusy(false);
    }
  }, [login, completeLogin, isReady]);

  const handleUnlock = useCallback(async () => {
    setFailure(undefined);
    setBusy(true);
    try {
      const outcome = await unlock();
      if (outcome.outcome === 'failed') setFailure('unlock');
    } finally {
      setBusy(false);
    }
  }, [unlock]);

  if (phase === 'authenticated') {
    return <Redirect href="/home" />;
  }

  const locked = phase === 'locked';

  return (
    <Screen>
      <Heading>{locked ? t('login.lockedHeading') : t('login.signedOutHeading')}</Heading>

      {locked ? (
        <>
          <BodyText>{t('login.lockedBody')}</BodyText>
          {biometricAvailable === false ? (
            <>
              <BodyText>{t('login.unlockUnavailableBody')}</BodyText>
              <Button
                label={t('login.signInInsteadButton')}
                onPress={handleSignIn}
                busy={busy}
                disabled={!isReady}
              />
            </>
          ) : (
            <>
              <Button label={t('login.unlockButton')} onPress={handleUnlock} busy={busy} />
              <BodyText tone="muted">{t('login.unlockHint')}</BodyText>
            </>
          )}
        </>
      ) : (
        <>
          <BodyText>{t('login.signedOutBody')}</BodyText>
          <Button
            label={t('login.signInButton')}
            onPress={handleSignIn}
            busy={busy}
            disabled={!isReady}
          />
          {/*
            Says WHY the button is dimmed. It was disabled on `!isReady`,
            which requires OIDC discovery — a network call — so an offline
            patient saw a permanently dimmed "Sign in" with no explanation
            anywhere, and VoiceOver announced "Sign in, dimmed" and stopped.
          */}
          {!isReady ? <BodyText tone="muted">{t('login.offlineBody')}</BodyText> : null}
        </>
      )}

      {message ? (
        <>
          <BodyText tone="error">{t(message)}</BodyText>
          {/*
            The retry runs the action that FAILED.
            
            "Try again" was wired to `handleSignIn` unconditionally, so a
            patient whose fingerprint misread — a bandaged or post-surgical
            hand, which `biometricUnlock.ts` explicitly anticipates — was
            thrown into a browser OIDC login needing internet. In a public
            restroom with no signal that button locked them out of their own
            diary.
          */}
          <Button
            label={t(failure === 'unlock' ? 'login.unlockRetryButton' : 'login.tryAgainButton')}
            onPress={failure === 'unlock' ? handleUnlock : handleSignIn}
            busy={busy}
          />
        </>
      ) : null}
    </Screen>
  );
}

const FAILURE_COPY_KEY: Record<LoginFailure, string> = {
  signIn: 'login.errorBody',
  unlock: 'login.unlockFailedBody',
  cancelled: 'login.cancelledBody',
  unavailable: 'login.offlineBody',
};
