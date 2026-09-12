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
}

export function loadOidcConfig(): OidcConfig {
  const issuer = import.meta.env.VITE_OIDC_ISSUER;
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID;
  const redirectUri = import.meta.env.VITE_OIDC_REDIRECT_URI;

  if (!issuer || !clientId || !redirectUri) {
    throw new Error(
      'Missing OIDC configuration. Set VITE_OIDC_ISSUER, VITE_OIDC_CLIENT_ID and ' +
        'VITE_OIDC_REDIRECT_URI — see apps/web/.env.example.',
    );
  }

  return { issuer, clientId, redirectUri };
}
