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
  /**
   * The issuer's own claim about its identity. REQUIRED by OpenID Connect
   * Discovery 1.0 §3, and validated here — see `assertIssuerMatches`.
   */
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  /**
   * RP-initiated logout (OpenID Connect RP-Initiated Logout 1.0 §2).
   * OPTIONAL: an issuer that does not advertise one cannot have its session
   * ended by this app, and `signOut` says what that costs.
   */
  readonly end_session_endpoint?: string;
}

/**
 * Compares two issuer identifiers.
 *
 * Discovery §4.3 says the returned `issuer` MUST be *identical* to the URL
 * used to retrieve the document. The one normalization applied here is a
 * trailing slash, because `fetchDiscoveryDocument` strips it from the
 * configured value before building the well-known URL, so a configured
 * `https://idp.example/` would otherwise never match a document saying
 * `https://idp.example`. That normalization cannot be used to point the
 * comparison at a different host, scheme, or path, which is what the check
 * is defending.
 */
function issuersMatch(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
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

    // OpenID Connect Discovery 1.0 §4.3, and the reason it is normative:
    // this document is what tells the app where to send the user's
    // credentials and where to redeem an authorization code. Fetching it
    // over a hijacked DNS answer, a compromised proxy, or a misconfigured
    // `VITE_OIDC_ISSUER` pointing at an attacker-controlled host yields a
    // perfectly well-formed document naming an attacker's
    // `authorization_endpoint`. Every later step then succeeds — the user
    // signs in, a token comes back, the app looks normal — while the
    // credentials went somewhere else. The issuer check is the only place
    // in this flow where the document's self-declared identity is compared
    // against the identity the deployment intended.
    if (!document.issuer || !issuersMatch(document.issuer, issuer)) {
      throw new Error(
        `OIDC discovery document from ${url} declares a different issuer than the one configured.`,
      );
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
