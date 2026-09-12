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

import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearPkceState,
  clearTokens,
  loadPkceState,
  loadTokens,
  savePkceState,
  saveSignOutReason,
  saveTokens,
  takeSignOutReason,
} from './session-storage.js';

beforeEach(() => {
  sessionStorage.clear();
});

describe('malformed stored values are discarded, not thrown on', () => {
  /**
   * `JSON.parse` was called bare on both keys. Anything unparseable under
   * them — a truncated write, a schema change between deploys, another app
   * on the same origin — threw out of `initialize()`, and with no error
   * boundary the app sat on "Signing you in…" forever with nothing rendered
   * that could tell the user to clear site data.
   */
  it.each([
    ['tokens', 'ostomy.auth.tokens', loadTokens],
    ['PKCE state', 'ostomy.auth.pkce', loadPkceState],
  ])('returns undefined for unparseable %s rather than throwing', (_label, key, load) => {
    sessionStorage.setItem(key, '{not json');
    expect(load()).toBeUndefined();
  });

  it.each([
    ['tokens', 'ostomy.auth.tokens', loadTokens],
    ['PKCE state', 'ostomy.auth.pkce', loadPkceState],
  ])('clears the unparseable %s, so the next load is not broken too', (_label, key, load) => {
    // Returning undefined without clearing would make EVERY subsequent visit
    // fail identically — the value cannot parse this time or next time.
    sessionStorage.setItem(key, '{not json');
    load();
    expect(sessionStorage.getItem(key)).toBeNull();
  });
});

describe('round-tripping', () => {
  it('stores and reads back tokens, including the fields sign-out depends on', () => {
    saveTokens({
      accessToken: 'at',
      expiresAt: 123,
      refreshToken: 'rt',
      idToken: 'it',
    });
    expect(loadTokens()).toEqual({
      accessToken: 'at',
      expiresAt: 123,
      refreshToken: 'rt',
      idToken: 'it',
    });
  });

  it('stores and reads back the PKCE pair', () => {
    savePkceState({ codeVerifier: 'v', state: 's' });
    expect(loadPkceState()).toEqual({ codeVerifier: 'v', state: 's' });
  });

  it.each([
    ['tokens', saveTokens, loadTokens, clearTokens, { accessToken: 'at', expiresAt: 1 }],
    ['PKCE state', savePkceState, loadPkceState, clearPkceState, { codeVerifier: 'v', state: 's' }],
  ])('clears %s', (_label, save, load, clear, value) => {
    (save as (v: unknown) => void)(value);
    (clear as () => void)();
    expect((load as () => unknown)()).toBeUndefined();
  });

  it('returns undefined when nothing is stored at all', () => {
    expect(loadTokens()).toBeUndefined();
    expect(loadPkceState()).toBeUndefined();
  });
});

describe('the sign-out reason', () => {
  it('is consumed on read, so it is shown once rather than on every later load', () => {
    // It survives an RP-initiated logout redirect, which leaves the origin
    // entirely. Leaving it in place would re-announce "your session timed
    // out" on a sign-in the user initiated themselves days later.
    saveSignOutReason('session_idle');
    expect(takeSignOutReason()).toBe('session_idle');
    expect(takeSignOutReason()).toBeUndefined();
  });

  it('is undefined when no sign-out happened', () => {
    expect(takeSignOutReason()).toBeUndefined();
  });
});
