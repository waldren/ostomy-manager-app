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

/**
 * The landing pad for the OIDC redirect, and nothing else.
 *
 * **Its filename must match `REDIRECT_URI_OPTIONS.path` in
 * `src/auth/useOidcLogin.ts`.** That constant builds
 * `ostomydiary://redirect`, which is what the authorization endpoint sends
 * the patient back to; this file is the route that URL resolves to.
 * Renaming either one alone re-breaks sign-in.
 *
 * ## Why a route is needed at all when the token exchange already works
 *
 * Found by R.S1's Gate B walkthrough. Authentication itself is fine:
 * `promptAsync()` resolves `success`, the code is extracted, and
 * `exchangeCodeAsync` returns tokens. But Android *also* delivers the
 * redirect to the app as an ordinary deep link, and Expo Router routes on
 * it. With no route for this path the patient landed on the framework's
 * "Unmatched Route" screen — signed in, with a live session, looking at a
 * page-not-found error and no way forward.
 *
 * So the bug this fixes is navigation, not auth, and the distinction
 * matters: nothing was wrong with the credentials, the PKCE exchange, or
 * the session. Reaching for an auth fix here would have changed working
 * code.
 *
 * ## Why it redirects to `/` rather than to `/home`
 *
 * `index.tsx` already owns the "which screen does this phase mean" rule —
 * `/home` when authenticated, `/login` otherwise — and `login.tsx`
 * redirects to `/home` itself once the phase flips. Sending this route
 * straight to `/home` would duplicate that decision in a third place and
 * would be wrong whenever the exchange has not finished yet, or failed:
 * it would show a signed-out patient the home screen.
 *
 * Bouncing through `/` keeps one owner for the rule and is correct
 * whichever order the deep link and the token exchange happen to land in.
 */
export default function OidcRedirect(): React.JSX.Element {
  return <Redirect href="/" />;
}
