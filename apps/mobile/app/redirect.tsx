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

import { Redirect, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useAuth } from '../src/auth/AuthContext';
import { getOidcClientConfig } from '../src/auth/oidcConfig';
import {
  exchangeAuthorizationCode,
  readAuthorizationCallback,
  useAutoDiscovery,
} from '../src/auth/oidcSession';
import { clearPendingAuthRequest, getPendingAuthRequest } from '../src/auth/pendingAuthRequest';
import { BodyText } from '../src/ui/BodyText';
import { Heading } from '../src/ui/Heading';
import { Screen } from '../src/ui/Screen';

/**
 * The OIDC redirect landing pad, **and the thing that completes sign-in**
 * (ADR-0021).
 *
 * **Its filename must match `REDIRECT_URI_OPTIONS.path` in
 * `src/auth/useOidcLogin.ts`.** That constant builds `ostomydiary://redirect`,
 * which is where the authorization endpoint sends the patient; this file is the
 * route that URL resolves to. Renaming either alone re-breaks sign-in.
 *
 * ## Why the exchange happens here rather than in the hook that started it
 *
 * R.S1 added this route because Android delivers the redirect to the app as an
 * ordinary deep link and Expo Router routes on it — without a route the patient
 * landed on "Unmatched Route". That reason still holds. What P3.S2's hardware
 * work found is that the deep link is not merely *also* delivered; on this
 * platform it is the **only** delivery that happens (#72).
 *
 * `MainActivity` is the only component declaring the `ostomydiary` BROWSABLE
 * filter, and `launchMode="singleTask"` brings its existing task to the front
 * (`START_TASK_TO_FRONT`), tearing down the Custom Tab.
 * `expo-web-browser`'s `BrowserProxyActivity` — which is what resolves
 * `promptAsync()` — is never the target, so the hook's promise never reported
 * the success it was waiting for and sign-in could not complete at all.
 *
 * The code was never lost. It is right here, in this route's params. Reading it
 * from the URL works whichever component the platform resolves the redirect to,
 * and needs no change to the native manifest — whose `singleTask` mode is
 * load-bearing for every other deep link this app handles.
 *
 * ## One completer, because a code is single-use
 *
 * `useOidcLogin` no longer exchanges anything. If both did, whichever ran
 * second would be refused by the token endpoint, and that refusal would surface
 * to the patient as a failed sign-in that had in fact succeeded.
 *
 * ## Every outcome is reported; none is swallowed
 *
 * `state` is verified before the exchange (`readAuthorizationCallback`), so a
 * link opened by anything else cannot drive a token request. A mismatch, a
 * missing pending request, a provider error and a failed exchange all end as
 * `signIn` failure on the login screen — via `AuthContext`, because this route
 * navigates away immediately and the login screen it lands on is a fresh mount
 * that cannot see state set here.
 */
/**
 * How long to wait for the discovery document before giving up.
 *
 * `useAutoDiscovery` fetches `/.well-known/openid-configuration`, and this
 * route cannot exchange anything until it resolves. Without a bound, a patient
 * whose network dropped between authorizing and returning would sit on the
 * "finishing sign-in" screen forever — the hang this route's own design has to
 * answer for, since the dismissal signal that covers the browser-closed case
 * lives on the login screen, which is unmounted by the time this runs.
 *
 * Generous on purpose. This is one request to an endpoint the app has usually
 * already reached, and a false failure costs the patient a whole round trip
 * through the browser, so the number errs towards waiting.
 */
const DISCOVERY_TIMEOUT_MS = 20_000;

export default function OidcRedirect(): React.JSX.Element {
  const params = useLocalSearchParams();
  const { completeLogin, reportSignInFailure } = useAuth();
  const { t } = useTranslation('mobile');
  const config = getOidcClientConfig();
  const discovery = useAutoDiscovery(config.issuer);

  /*
    This route must NOT navigate away until it has finished.

    It used to render `<Redirect href="/" />` unconditionally, on the argument
    that the login screen is where the patient should wait. That was wrong for a
    reason only a device showed: `useAutoDiscovery` is an async fetch, so
    `discovery` is `null` on the first render — the route unmounted before it
    resolved, and the effect never ran again. The code and state arrived
    correctly and were then dropped on the floor.

    So the redirect is gated on this. Until the work is finished the route holds
    and says what it is doing; a navigation mid-flight is the one thing that
    guarantees the flow cannot complete.
  */
  const [finished, setFinished] = useState(false);

  /*
    Guards against a second run.

    This effect depends on `discovery`, which arrives asynchronously, and the
    route can re-render while the exchange is in flight. A code is single-use:
    a second attempt would be refused by the token endpoint and would report a
    failure for a sign-in that had already succeeded. A ref, not state —
    setting state here would itself trigger the re-render being guarded.
  */
  const started = useRef(false);

  /*
    The bound on waiting for discovery. Separate from the work effect so the
    timer starts when the route mounts, not when discovery resolves.
  */
  useEffect(() => {
    if (finished || discovery !== null) return;
    const timer = setTimeout(() => {
      // Only if nothing has started: a slow discovery that resolved just in
      // time must not have its exchange reported as a failure.
      if (!started.current) {
        started.current = true;
        void clearPendingAuthRequest();
        reportSignInFailure();
        setFinished(true);
      }
    }, DISCOVERY_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [discovery, finished, reportSignInFailure]);

  useEffect(() => {
    if (discovery === null || started.current) return;
    started.current = true;

    void (async () => {
      const pending = await getPendingAuthRequest();
      const outcome = readAuthorizationCallback(params, pending);

      // Cleared before anything can fail, and on every path. A verifier left
      // behind is a secret kept for no reason, and a stale `state` would later
      // be checked against a request nobody is waiting on.
      await clearPendingAuthRequest();

      if (outcome.kind === 'not-a-callback') {
        // The route was reached without a code — a stray deep link, or a warm
        // start onto this path. Nothing failed, so nothing is reported; the
        // redirect below sends the patient wherever their phase belongs.
        setFinished(true);
        return;
      }
      if (outcome.kind !== 'authorization') {
        reportSignInFailure();
        setFinished(true);
        return;
      }

      try {
        const tokens = await exchangeAuthorizationCode(discovery, config, outcome.authorization);
        await completeLogin(tokens);
      } catch {
        // Never log the error. It can embed the authorization code or
        // provider-side detail, and this app has no sanctioned diagnostic sink
        // for auth failures — the same rule `login.tsx` already follows.
        reportSignInFailure();
      } finally {
        // `finally`, so a thrown exchange still releases the hold. Without it a
        // failed sign-in would leave the patient on this screen with no way
        // forward — a worse outcome than the one being reported.
        setFinished(true);
      }
    })();
  }, [discovery, params, config, completeLogin, reportSignInFailure]);

  /*
    Redirects to `/` rather than `/home`, unchanged from R.S1's reasoning.

    `index.tsx` owns the "which screen does this phase mean" rule, and
    `login.tsx` moves to `/home` itself once the phase flips. Sending this route
    straight to `/home` would put that decision in a third place and would be
    wrong when the exchange failed: it would show a signed-out patient the home
    screen.
  */
  if (finished) return <Redirect href="/" />;

  /*
    The waiting state, which is also the accessible one.

    A bare `null` would hold the route correctly and tell a screen-reader user
    nothing at all — they authorized in a browser, came back, and met silence.
    `Heading` takes focus order's first position, so what is announced is what
    is happening.
  */
  return (
    <Screen>
      <Heading>{t('login.completingHeading')}</Heading>
      <BodyText>{t('login.completingBody')}</BodyText>
    </Screen>
  );
}
