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
 * Test-only OIDC token fixtures. Shared by both `jwt-auth.guard.spec.ts` and
 * `admin-jwt-auth.guard.spec.ts` (and the cross-boundary spec) — this is test
 * infrastructure, not the guards' own authorization logic, so sharing it
 * does not touch the "no shared code between the two guards" rule those
 * files document. No network access: `jose.createLocalJWKSet` builds a JWKS
 * matcher directly from an in-memory key, per the sprint requirement to test
 * with mocked JWKS only.
 */
import { exportJWK, generateKeyPair, createLocalJWKSet, SignJWT, type JWTVerifyGetKey } from 'jose';

export interface TestOidcIssuer {
  getKey: JWTVerifyGetKey;
  /** Signs a token with this issuer's own key. `kid` matches the published JWK, so a real signature-verification path is exercised. */
  sign: (claims: {
    issuer: string;
    audience: string;
    subject: string;
    subjectClaim?: string;
    expiresIn?: string;
  }) => Promise<string>;
}

const KEY_ID = 'test-key';

export async function createTestOidcIssuer(): Promise<TestOidcIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  jwk.kid = KEY_ID;

  const getKey = createLocalJWKSet({ keys: [jwk] });

  return {
    getKey,
    async sign({ issuer, audience, subject, subjectClaim = 'sub', expiresIn = '1h' }) {
      return new SignJWT({ [subjectClaim]: subject })
        .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
        .setIssuer(issuer)
        .setAudience(audience)
        .setIssuedAt()
        .setExpirationTime(expiresIn)
        .sign(privateKey);
    },
  };
}

/** A second, unrelated issuer — for "signed by the wrong key" tests. Deliberately reuses `KEY_ID` so a real signature check (not a "no matching key" short-circuit) is what rejects the token. */
export async function signWithUnrelatedKey(claims: {
  issuer: string;
  audience: string;
  subject: string;
  subjectClaim?: string;
}): Promise<string> {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  return new SignJWT({ [claims.subjectClaim ?? 'sub']: claims.subject })
    .setProtectedHeader({ alg: 'RS256', kid: KEY_ID })
    .setIssuer(claims.issuer)
    .setAudience(claims.audience)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(privateKey);
}
