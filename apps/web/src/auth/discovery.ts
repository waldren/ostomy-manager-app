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
 * Standard OIDC discovery (`/.well-known/openid-configuration`) rather than
 * hardcoding the authorization/token endpoints — the same "the API only
 * ever talks to whatever standard OIDC issuer is configured" principle
 * CLAUDE.md states for the backend applies here: swapping the mock issuer
 * in development for the production identity provider is a configuration
 * change, never a code change.
 */
export interface OidcDiscoveryDocument {
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly end_session_endpoint?: string;
}

const discoveryCache = new Map<string, Promise<OidcDiscoveryDocument>>();

export function fetchDiscoveryDocument(issuer: string): Promise<OidcDiscoveryDocument> {
  const cached = discoveryCache.get(issuer);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const url = `${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`OIDC discovery request to ${url} failed with status ${response.status}`);
    }
    const document = (await response.json()) as Partial<OidcDiscoveryDocument>;
    if (!document.authorization_endpoint || !document.token_endpoint) {
      throw new Error(`OIDC discovery document from ${url} is missing required endpoints`);
    }
    return document as OidcDiscoveryDocument;
  })();

  discoveryCache.set(issuer, promise);
  // A failed discovery must not poison the cache for a later, successful retry.
  promise.catch(() => discoveryCache.delete(issuer));
  return promise;
}

/** Test-only: clears the module-level cache between specs. */
export function resetDiscoveryCacheForTests(): void {
  discoveryCache.clear();
}
