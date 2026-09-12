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

import { createApiClient, type ApiClient } from '@ostomy/core/api-client';

/**
 * Builds the shared, generated API client (packages/core/src/api-client,
 * P2.S1a) against this app's configured API origin. `getAccessToken` is
 * supplied by the caller (`AuthContext`'s `getAccessToken`) and is called
 * per request, so a refreshed token is always picked up — see the
 * generated client's own doc comment on `ApiClientOptions.getAccessToken`.
 */
export function createWebApiClient(getAccessToken: () => Promise<string | undefined>): ApiClient {
  const baseUrl = import.meta.env.VITE_API_BASE_URL;
  if (!baseUrl) {
    throw new Error('Missing VITE_API_BASE_URL — see apps/web/.env.example.');
  }
  return createApiClient({ baseUrl, getAccessToken });
}
