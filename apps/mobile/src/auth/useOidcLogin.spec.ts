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
 * The redirect URI this app hands the authorization endpoint.
 *
 * This file exists because of what R.S1's Gate B walkthrough found.
 * `useOidcLogin.ts` had no spec at all, and it called
 * `makeRedirectUri()` with no arguments — which returns the **bare
 * scheme** `ostomydiary://`: no authority, no path, not a legal absolute
 * URI. The authorization endpoint refused every request before any user
 * interaction (`invalid_request` / "illegal redirect_uri parameter", a
 * Nimbus `ParseException`), so sign-in could not complete against the
 * development stack and no clinical screen in this app was reachable.
 *
 * The suite was green the whole time. `oidcSession.spec.ts` passes
 * `'ostomydiary://redirect'` as its fixture — a legal URI, with a path —
 * so every test around this asserted a value production never produced.
 * A fixture is not a contract with the caller.
 *
 * What is asserted here is the **options object**, not a rendered hook.
 * Driving `useOidcLogin` under `renderHook` to observe one `useMemo`
 * means mocking `expo-auth-session` wholesale, and a stub that omits
 * `ResponseType.Code` fails somewhere that says nothing about redirect
 * URIs. `REDIRECT_URI_OPTIONS` is exported for exactly this reason, the
 * way `oidcSession.ts` keeps the plain testable pieces out of the hook.
 *
 * The gap this leaves, stated rather than papered over: nothing here
 * proves the hook passes the constant to `makeRedirectUri`. Only a device
 * run proves that, and a device run is what found the defect.
 */

import { REDIRECT_URI_OPTIONS } from './useOidcLogin';

describe('REDIRECT_URI_OPTIONS — what makes the redirect URI legal', () => {
  it('carries a scheme', () => {
    expect(REDIRECT_URI_OPTIONS.scheme).toBe('ostomydiary');
  });

  it('carries a non-empty path, which is the half whose absence broke sign-in', () => {
    // Deliberately not an equality check against 'redirect'. Any path
    // produces a legal URI; no path is what the authorization endpoint
    // rejected, and pinning the exact word would turn a rename into a
    // failure while leaving the real invariant unasserted.
    expect(REDIRECT_URI_OPTIONS.path).toBeTruthy();
    expect(REDIRECT_URI_OPTIONS.path.length).toBeGreaterThan(0);
  });

  it('composes into an absolute URI, not a bare scheme', () => {
    const composed = `${REDIRECT_URI_OPTIONS.scheme}://${REDIRECT_URI_OPTIONS.path}`;

    expect(composed).not.toBe('ostomydiary://');
    expect(composed).toMatch(/^ostomydiary:\/\/.+/);
  });
});
