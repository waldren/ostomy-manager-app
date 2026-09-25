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
 * `readAuthorizationCallback` — the decision that turns a deep-link URL into
 * an exchangeable authorization (ADR-0021).
 *
 * This is the security boundary of the fix for #72. The completer is driven by
 * a URL, and anything on the device can open a link with this app's scheme, so
 * what this function refuses matters more than what it accepts.
 */

import { readAuthorizationCallback } from './oidcSession';

const PENDING = {
  codeVerifier: 'verifier-abc',
  state: 'state-xyz',
  redirectUri: 'ostomydiary://redirect',
} as const;

describe('readAuthorizationCallback', () => {
  it('returns the authorization when code and state match the request in flight', () => {
    const outcome = readAuthorizationCallback({ code: 'the-code', state: 'state-xyz' }, PENDING);

    expect(outcome).toEqual({
      kind: 'authorization',
      authorization: {
        code: 'the-code',
        // From the PERSISTED request, never re-derived: the token endpoint
        // compares `redirect_uri` byte for byte.
        redirectUri: 'ostomydiary://redirect',
        codeVerifier: 'verifier-abc',
      },
    });
  });

  /**
   * The CSRF check (RFC 6749 §10.12), and the reason this function exists
   * rather than the route reading `params.code` directly.
   *
   * Without it, any app or link that can open `ostomydiary://redirect?code=...`
   * drives a token request with this client's verifier. The code would be one
   * the attacker obtained, and the session it produced would be theirs, in this
   * patient's app, against this patient's local store.
   */
  describe('refuses anything it did not ask for', () => {
    it('refuses a state that does not match', () => {
      const outcome = readAuthorizationCallback(
        { code: 'the-code', state: 'not-the-state' },
        PENDING,
      );

      expect(outcome).toEqual({ kind: 'unexpected' });
    });

    it('refuses a code with no state at all', () => {
      expect(readAuthorizationCallback({ code: 'the-code' }, PENDING)).toEqual({
        kind: 'unexpected',
      });
    });

    /**
     * No request in flight. Either nothing started one, or a previous outcome
     * already cleared it — and a second redirect for an exchange that already
     * happened must not be attempted again, because the code is single-use and
     * the token endpoint would refuse it.
     */
    it('refuses a code when no request is pending', () => {
      expect(
        readAuthorizationCallback({ code: 'the-code', state: 'state-xyz' }, undefined),
      ).toEqual({ kind: 'unexpected' });
    });

    /**
     * A repeated query parameter arrives as an array. A real provider sends
     * one value, so the array form is treated as absent rather than having its
     * first element picked — choosing which of two values to trust is how
     * parameter pollution becomes an exploit.
     */
    it('treats a repeated parameter as absent rather than picking one', () => {
      const outcome = readAuthorizationCallback(
        { code: ['first', 'second'], state: 'state-xyz' },
        PENDING,
      );

      expect(outcome).toEqual({ kind: 'not-a-callback' });
    });

    it('treats a repeated state as a mismatch rather than trusting one', () => {
      const outcome = readAuthorizationCallback(
        { code: 'the-code', state: ['state-xyz', 'other'] },
        PENDING,
      );

      expect(outcome).toEqual({ kind: 'unexpected' });
    });
  });

  /**
   * RFC 6749 §4.1.2.1: the provider reports failure in the redirect itself.
   * Distinguished from `unexpected` because the patient needs telling either
   * way, but only one of them indicates something wrong with this app.
   */
  it('reports a provider error, and does not look for a code alongside it', () => {
    expect(
      readAuthorizationCallback({ error: 'access_denied', state: 'state-xyz' }, PENDING),
    ).toEqual({ kind: 'provider-error' });
  });

  it('reports a provider error even when a code is also present', () => {
    expect(
      readAuthorizationCallback(
        { error: 'invalid_scope', code: 'the-code', state: 'state-xyz' },
        PENDING,
      ),
    ).toEqual({ kind: 'provider-error' });
  });

  /**
   * Reached without a code — a stray deep link, or a warm start onto this
   * path. Distinct from every failure above: nothing was attempted, so nothing
   * should be reported to the patient as a failed sign-in.
   */
  describe('not a callback at all', () => {
    it('says so for empty params', () => {
      expect(readAuthorizationCallback({}, PENDING)).toEqual({ kind: 'not-a-callback' });
    });

    it('says so even with a request in flight', () => {
      expect(readAuthorizationCallback({ state: 'state-xyz' }, PENDING)).toEqual({
        kind: 'not-a-callback',
      });
    });

    it('says so when there is no request in flight either', () => {
      expect(readAuthorizationCallback({}, undefined)).toEqual({ kind: 'not-a-callback' });
    });
  });
});
