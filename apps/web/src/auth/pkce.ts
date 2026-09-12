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
 * OAuth 2.0 Authorization Code + PKCE (RFC 7636) primitives, implemented
 * against the standard Web Crypto API rather than a vendored OIDC client
 * library, so this app never depends on anything Cognito-specific
 * (CLAUDE.md "Never import a Cognito SDK into request handling" — the same
 * principle applies on the client: the API takes a standard OIDC issuer,
 * and so does this app).
 */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A cryptographically random, unguessable value — RFC 7636 requires 43-128 characters after encoding; 64 random bytes base64url-encodes to 86. */
export function generateRandomUrlSafeString(): string {
  const bytes = new Uint8Array(64);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

/** The PKCE `code_verifier` (RFC 7636 §4.1). */
export function generateCodeVerifier(): string {
  return generateRandomUrlSafeString();
}

/** The PKCE `code_challenge` (RFC 7636 §4.2), S256 method — the verifier's SHA-256 digest, base64url-encoded. */
export async function generateCodeChallenge(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  return base64UrlEncode(new Uint8Array(digest));
}
