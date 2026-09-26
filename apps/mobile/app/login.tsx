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
import { isLocalUnlockAvailable } from '../src/auth/biometricUnlock';
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
  const { phase, unlock, signInFailed, clearSignInFailure, signedOutReason } = useAuth();
  const { t } = useTranslation('mobile');
  const { isReady, login } = useOidcLogin();
  /**
   * Failures this screen owns end to end: a biometric unlock that failed, a
   * browser the patient dismissed, discovery that never resolved.
   *
   * A failed OIDC **exchange** is deliberately not here. That outcome is
   * decided in `app/redirect.tsx` after a navigation that remounts this
   * component, so state set there cannot be read here — it lives on
   * `AuthContext` as `signInFailed` and is merged in below. See ADR-0021.
   */
  const [localFailure, setLocalFailure] = useState<LoginFailure | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [unlockAvailable, setUnlockAvailable] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    if (phase !== 'locked') return;
    let cancelled = false;
    isLocalUnlockAvailable().then((available) => {
      if (!cancelled) setUnlockAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  // The context's flag wins when set, because it describes an attempt that
  // actually reached the provider — strictly more informative than anything
  // this mount could know, since this mount did not start it.
  const failure: LoginFailure | undefined = signInFailed ? 'signIn' : localFailure;
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
    setLocalFailure(undefined);
    // Cleared here too: a previous attempt's failure must not be shown over a
    // fresh one still in progress, and this is the only place a fresh one
    // starts.
    clearSignInFailure();
    setBusy(true);
    try {
      // `login()` LAUNCHES the flow; it does not complete it (ADR-0021).
      // `app/redirect.tsx` performs the exchange and calls `completeLogin`,
      // because on Android the redirect only ever arrives as a deep link (#72).
      const outcome = await login();
      if (outcome === 'unavailable') {
        setLocalFailure('unavailable');
      } else if (outcome === 'dismissed') {
        // The browser closed with no redirect following it — the patient
        // pressed Back or cancelled at the provider. Without this the screen
        // would wait on a completion that is never coming.
        setLocalFailure('cancelled');
      }
      // `launched` deliberately sets nothing. The redirect route decides the
      // outcome, and this component is about to be remounted by its
      // navigation — which is exactly why the failure it may report lives on
      // the context rather than here.
    } catch {
      // Never log the error: it may embed a query string carrying an
      // authorization code or provider-side detail, and this app has no
      // sanctioned diagnostic sink for auth failures.
      setLocalFailure('signIn');
    } finally {
      setBusy(false);
    }
  }, [login, clearSignInFailure]);

  const handleUnlock = useCallback(async () => {
    setLocalFailure(undefined);
    setBusy(true);
    try {
      const outcome = await unlock();
      if (outcome.outcome === 'failed') setLocalFailure('unlock');
      // `unavailable` means the OS has nothing to prompt with — the startup check
      // never resolved, or the screen lock was removed between that check and this
      // tap. Route to the branch that SAYS so: leaving it unhandled makes the one
      // control on the screen appear to work and do nothing at all, with no status
      // message for a user-initiated action.
      //
      // NOT `setLocalFailure('unavailable')` — that key already means "OIDC
      // discovery is unreachable" and maps to `login.offlineBody`.
      if (outcome.outcome === 'unavailable') setUnlockAvailable(false);
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
          {unlockAvailable === false ? (
            <>
              {/*
                `live` because this branch REPLACES the unlock button after an async
                check resolves. A TalkBack user whose focus was on "Unlock my diary"
                loses it when that node unmounts, with nothing announced — the same
                class of silent swap this screen already announces explicitly for the
                sign-in failure below.
              */}
              <BodyText live="polite">{t('login.unlockUnavailableBody')}</BodyText>
              <Button
                label={t('login.signInInsteadButton')}
                onPress={handleSignIn}
                busy={busy}
                disabled={!isReady}
              />
              {/*
                Says WHY the button is dimmed, for the same reason the signed-out
                branch below does: `isReady` needs OIDC discovery, so an offline
                patient here saw a permanently dimmed button, was told to sign in
                again, and had nothing on the screen accounting for either. The
                explanation existed and was rendered only in the other branch.
              */}
              {!isReady ? <BodyText tone="muted">{t('login.offlineBody')}</BodyText> : null}
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
          {/*
            Why the app signed them out, when it did (#74).

            A patient who has been opening "Welcome back / Unlock my diary" for weeks
            lands here instead, and the available inference is that their diary is
            gone. It is not: the purge touches only the token, and re-login under the
            same subject matches the database owner, so nothing is erased. Cause
            before instruction, which is the order `home.tsx` uses for the same kind
            of block.

            No live region: this route mounts fresh after `checking`, so it is
            initial content and reading order carries it.
          */}
          {signedOutReason === 'unlock-settings-changed' ? (
            <>
              <Heading level={2}>{t('login.unlockChangedHeading')}</Heading>
              <BodyText>{t('login.unlockChangedBody')}</BodyText>
            </>
          ) : null}
          {/*
            An ordinary expired or revoked sign-in (#40). Separate copy from the
            enrolment case above, which asserts something about the phone's security
            that is not true here — the patient did nothing, and telling them their
            unlock settings changed would send them looking for a problem that does
            not exist.
          */}
          {signedOutReason === 'session-expired' ? (
            <>
              <Heading level={2}>{t('login.sessionEndedHeading')}</Heading>
              <BodyText>{t('login.sessionEndedBody')}</BodyText>
            </>
          ) : null}
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
