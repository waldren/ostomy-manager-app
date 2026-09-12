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
 * Patient OIDC configuration, resolved entirely from build-time environment
 * variables (see `.env.example`) — never a Cognito-specific import
 * (CLAUDE.md). In development these point at the `mock-oauth2-server`'s
 * patient issuer (`apps/api/.env.example`'s `OIDC_ISSUER`); in production
 * they point at the patient Cognito user pool's hosted UI. This app never
 * talks to the admin issuer — that identity pool is disjoint by design
 * (SRS_v2 §4.6) and this codebase has no admin surface at all.
 */
export interface OidcConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /**
   * The API's resource identifier, sent as the `audience` request parameter.
   *
   * **This is not the client id and the difference is load-bearing.**
   * `apps/api`'s `JwtAuthGuard` validates `aud === OIDC_AUDIENCE`
   * (`ostomy-patient-app`), while this SPA authenticates as `ostomy-web`.
   * Without an explicit audience, `mock-oauth2-server` mints
   * `aud: ["default-audience"]` and **every** API call returns 401 — the app
   * signs in successfully and then cannot read a single observation, with
   * the cause three layers from the symptom. Found by code review, not by a
   * test, because nothing in this repo yet exercises the SPA against a live
   * issuer.
   *
   * Configuration rather than a constant, for the same reason the issuer is:
   * a real deployment may need `resource` instead of `audience`, and the
   * value differs per environment.
   */
  readonly audience: string;
  /**
   * The scopes requested at authorization.
   *
   * Configurable because it is vendor-specific. `offline_access` was
   * hardcoded here and is **not a scope Cognito supports** — its hosted UI
   * returns `error=invalid_scope` and sign-in never completes. Cognito
   * issues refresh tokens from app-client configuration instead. The default
   * below is the portable subset; deployments that need more set it.
   */
  readonly scope: string;
  /**
   * Where the issuer returns the browser after ending its session.
   *
   * Must be registered with the issuer — an unregistered value makes the
   * `end_session_endpoint` refuse the request outright, which is why this is
   * configuration and why `signOut` clears local state BEFORE redirecting.
   * Defaults to the app's own origin, which is the registered value in every
   * deployment shape this repo has.
   */
  readonly postLogoutRedirectUri: string;
  /**
   * Minutes of inactivity after which the session is ended. `0` disables the
   * timer.
   *
   * This is a shared-workstation control, not a token-lifetime control: the
   * access token's own expiry says nothing about whether the person who
   * signed in is still the person at the keyboard.
   */
  readonly idleTimeoutMinutes: number;
}

/** Portable across mock-oauth2-server and Cognito; see `OidcConfig.scope`. */
const DEFAULT_SCOPE = 'openid profile';

/**
 * Fifteen minutes, matching the value HHS's own security guidance and the
 * common EHR default converge on. Long enough not to interrupt a physician
 * reading a chart, short enough that an unattended clinic workstation is not
 * left showing one patient's stoma output to whoever sits down next.
 */
const DEFAULT_IDLE_TIMEOUT_MINUTES = 15;

/**
 * Parses the idle timeout, failing SAFE rather than open.
 *
 * A typo in the environment (`VITE_SESSION_IDLE_TIMEOUT_MINUTES=fifteen`)
 * would otherwise become `NaN`, and a `NaN` millisecond delay passed to
 * `setTimeout` is coerced to `0` — firing immediately and signing the user
 * out on every keystroke. Falling back to the default keeps the control
 * working; only an explicit `0` disables it.
 */
function parseIdleTimeoutMinutes(raw: string | undefined): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_IDLE_TIMEOUT_MINUTES;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_IDLE_TIMEOUT_MINUTES;
  }
  return parsed;
}

export function loadOidcConfig(): OidcConfig {
  const issuer = import.meta.env.VITE_OIDC_ISSUER;
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID;
  const redirectUri = import.meta.env.VITE_OIDC_REDIRECT_URI;
  const audience = import.meta.env.VITE_OIDC_AUDIENCE;
  const scope = import.meta.env.VITE_OIDC_SCOPE || DEFAULT_SCOPE;
  const postLogoutRedirectUri =
    import.meta.env.VITE_OIDC_POST_LOGOUT_REDIRECT_URI || window.location.origin;
  const idleTimeoutMinutes = parseIdleTimeoutMinutes(
    import.meta.env.VITE_SESSION_IDLE_TIMEOUT_MINUTES,
  );

  if (!issuer || !clientId || !redirectUri || !audience) {
    throw new Error(
      'Missing OIDC configuration. Set VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID, ' +
        'VITE_OIDC_REDIRECT_URI and VITE_OIDC_AUDIENCE — see apps/web/.env.example.',
    );
  }

  return {
    issuer,
    clientId,
    redirectUri,
    audience,
    scope,
    postLogoutRedirectUri,
    idleTimeoutMinutes,
  };
}
