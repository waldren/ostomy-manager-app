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

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadOidcConfig } from './oidc-config.js';

function stubRequired(): void {
  vi.stubEnv('VITE_OIDC_ISSUER', 'https://issuer.example');
  vi.stubEnv('VITE_OIDC_CLIENT_ID', 'ostomy-web');
  vi.stubEnv('VITE_OIDC_REDIRECT_URI', 'http://localhost:5173/');
  vi.stubEnv('VITE_OIDC_AUDIENCE', 'ostomy-patient-app');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('required configuration', () => {
  it.each([
    'VITE_OIDC_ISSUER',
    'VITE_OIDC_CLIENT_ID',
    'VITE_OIDC_REDIRECT_URI',
    'VITE_OIDC_AUDIENCE',
  ])('refuses to build a config with %s missing', (missing) => {
    // Failing loudly at load is the point. `VITE_OIDC_AUDIENCE` in
    // particular used not to be sent at all, and the symptom was a
    // successful sign-in followed by a 401 on every API call — a cause
    // three layers from where it shows up.
    stubRequired();
    vi.stubEnv(missing, '');
    expect(() => loadOidcConfig()).toThrow(/Missing OIDC configuration/);
  });
});

describe('defaults', () => {
  it('requests the portable scope set when none is configured', () => {
    // `offline_access` was hardcoded here and Cognito rejects it outright
    // with `error=invalid_scope`, so sign-in never completes. The default
    // must stay the subset every supported issuer accepts.
    stubRequired();
    expect(loadOidcConfig().scope).toBe('openid profile');
  });

  it('uses a configured scope when one is given', () => {
    stubRequired();
    vi.stubEnv('VITE_OIDC_SCOPE', 'openid profile email');
    expect(loadOidcConfig().scope).toBe('openid profile email');
  });

  it('defaults the post-logout redirect to the app origin', () => {
    stubRequired();
    expect(loadOidcConfig().postLogoutRedirectUri).toBe(window.location.origin);
  });
});

describe('the idle timeout fails safe, never open', () => {
  it('defaults to 15 minutes', () => {
    stubRequired();
    expect(loadOidcConfig().idleTimeoutMinutes).toBe(15);
  });

  it('honours an explicit 0 as "disabled"', () => {
    // The one value that turns the control off has to be deliberate, which
    // is why it is distinguished from every malformed value below.
    stubRequired();
    vi.stubEnv('VITE_SESSION_IDLE_TIMEOUT_MINUTES', '0');
    expect(loadOidcConfig().idleTimeoutMinutes).toBe(0);
  });

  it.each(['fifteen', '-5', 'NaN', ''])(
    'falls back to the default rather than 0 for the malformed value %o',
    (raw) => {
      // A typo would otherwise become NaN, and a NaN millisecond delay is
      // coerced to 0 — signing the user out on every poll. Falling back to
      // the default keeps a security control working through a deployment
      // mistake instead of turning it into a denial of service.
      stubRequired();
      vi.stubEnv('VITE_SESSION_IDLE_TIMEOUT_MINUTES', raw);
      expect(loadOidcConfig().idleTimeoutMinutes).toBe(15);
    },
  );

  it('accepts a configured value', () => {
    stubRequired();
    vi.stubEnv('VITE_SESSION_IDLE_TIMEOUT_MINUTES', '5');
    expect(loadOidcConfig().idleTimeoutMinutes).toBe(5);
  });
});
