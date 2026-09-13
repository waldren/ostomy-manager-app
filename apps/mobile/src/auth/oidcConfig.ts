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

import { loadEnv } from '../config/env';

/**
 * This app's OIDC client configuration, resolved from environment
 * configuration only (CLAUDE.md "Never import a Cognito SDK into request
 * handling" — the same rule applies here: nothing in this file, or
 * anything that consumes it, may name Cognito, a Cognito SDK type, or a
 * Cognito-specific claim shape. Production points this at the patient
 * Cognito user pool's hosted-UI domain; development points it at
 * mock-oauth2-server (infra/docker-compose.yml). Both speak the same
 * standard OIDC discovery/authorization-code+PKCE surface, so nothing
 * here changes between them.
 *
 * **The audience assumption.** `.env.example`'s own comment records this
 * in full; restated briefly here because it is the one thing about this
 * config that could not be verified empirically in the environment this
 * app was first built in (no device, no reachable mock-oauth2-server).
 * `clientId` and `audience` are the same string by design: apps/api's
 * `JwtAuthGuard` checks the token's `aud` claim against
 * `OIDC_AUDIENCE=ostomy-patient-app`, and mock-oauth2-server's documented
 * default (no `JSON_CONFIG` requestMappings override, which this stack's
 * `mock-oidc` service deliberately runs without) is that an issued
 * token's `aud` equals the authorization request's `client_id` verbatim.
 * If that assumption is wrong, this is the one place to change it.
 */
export interface OidcClientConfig {
  readonly issuer: string;
  readonly clientId: string;
  readonly audience: string;
  readonly scopes: readonly string[];
}

export function getOidcClientConfig(): OidcClientConfig {
  const env = loadEnv();
  return {
    issuer: env.oidcIssuer,
    clientId: env.oidcClientId,
    audience: env.oidcAudience,
    scopes: env.oidcScopes.split(' ').filter((scope) => scope.length > 0),
  };
}
