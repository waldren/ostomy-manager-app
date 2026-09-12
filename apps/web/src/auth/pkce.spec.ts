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

import { describe, expect, it } from 'vitest';

import { generateCodeChallenge, generateCodeVerifier } from './pkce.js';

describe('PKCE (RFC 7636)', () => {
  it('generates a code verifier of the length RFC 7636 requires (43-128 chars) and url-safe alphabet', () => {
    const verifier = generateCodeVerifier();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates a different verifier on every call', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });

  it('derives the S256 code challenge deterministically from the verifier', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    // Known-answer test vector from RFC 7636 Appendix B.
    const expectedChallenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
    expect(await generateCodeChallenge(verifier)).toBe(expectedChallenge);
  });

  it('produces a challenge that never equals the verifier itself', async () => {
    const verifier = generateCodeVerifier();
    expect(await generateCodeChallenge(verifier)).not.toBe(verifier);
  });
});
