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

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Patient OIDC issuer. Discovery is fetched from `${issuer}/.well-known/openid-configuration`. */
  readonly VITE_OIDC_ISSUER: string;
  /** The SPA's registered OIDC client id — distinct from the API's own `OIDC_AUDIENCE` (apps/api/.env.example). */
  readonly VITE_OIDC_CLIENT_ID: string;
  /** Must exactly match a redirect URI registered with the issuer. */
  readonly VITE_OIDC_REDIRECT_URI: string;
  /** The API's resource identifier, sent as the `audience` request parameter. NOT the client id — see `OidcConfig.audience`. */
  readonly VITE_OIDC_AUDIENCE: string;
  /** Space-delimited scopes. Optional; defaults to the portable `openid profile`. */
  readonly VITE_OIDC_SCOPE?: string;
  /** Where the issuer returns the browser after RP-initiated logout. Optional; defaults to the app origin. Must be registered with the issuer. */
  readonly VITE_OIDC_POST_LOGOUT_REDIRECT_URI?: string;
  /** Minutes of inactivity before the session ends. Optional; defaults to 15. `0` disables the timer. */
  readonly VITE_SESSION_IDLE_TIMEOUT_MINUTES?: string;
  /** Origin the API is served from, no trailing slash (packages/core's ApiClientOptions.baseUrl). */
  readonly VITE_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
