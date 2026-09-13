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

import { readSubjectClaim } from './tokenSubject';

/** Builds an unsigned JWT-shaped string. The signature is never inspected — see the module comment. */
function jwtWithPayload(payload: unknown): string {
  const encode = (value: string) =>
    Buffer.from(value, 'utf-8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode('{"alg":"none"}')}.${encode(JSON.stringify(payload))}.sig`;
}

describe('readSubjectClaim', () => {
  it('reads the subject from a well-formed token', () => {
    expect(readSubjectClaim(jwtWithPayload({ sub: 'patient-abc', aud: 'x' }))).toBe('patient-abc');
  });

  it('reads a UUID subject, the shape a real issuer emits', () => {
    // This payload genuinely requires base64 padding (its JSON length is
    // not a multiple of 3), so it exercises the `padEnd` in the parser.
    //
    // Stated plainly because it would be easy to over-claim: this test does
    // NOT prove that line is necessary. Node's `atob` — what jest runs —
    // accepts unpadded input, and removing the padding still passes here.
    // The padding is defensive for Hermes on device, whose `atob` follows
    // the spec more strictly and rejects a bad-length string. Verified by
    // mutation: dropping `padEnd` survives this suite.
    const subject = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    expect(readSubjectClaim(jwtWithPayload({ sub: subject }))).toBe(subject);
  });

  describe('fails to "not the same owner", never to "same owner"', () => {
    /**
     * The safety property. A caller uses this to decide whether the local
     * database belongs to the person signing in; `undefined` routes to
     * "purge", which destroys data on a device the user already controls
     * and discloses nothing. Returning a WRONG subject, or accidentally
     * matching, would hand one patient another's diary.
     */
    it.each([
      ['not a JWT at all', 'nonsense'],
      ['no payload segment', 'onlyonesegment'],
      ['payload that is not base64', 'aaa.!!!!.bbb'],
      ['payload that is not JSON', `aaa.${Buffer.from('nope').toString('base64')}.bbb`],
      ['empty string', ''],
    ])('returns undefined for %s', (_label, token) => {
      expect(readSubjectClaim(token)).toBeUndefined();
    });

    it.each([
      ['a missing sub claim', { aud: 'x' }],
      ['a non-string sub', { sub: 12345 }],
      ['an empty sub', { sub: '' }],
      ['a null payload', null],
    ])('returns undefined for %s', (_label, payload) => {
      expect(readSubjectClaim(jwtWithPayload(payload))).toBeUndefined();
    });
  });

  it('does not treat two different subjects as equal', () => {
    // The comparison this feeds is a plain !==, so the only way it can go
    // wrong is here.
    const a = readSubjectClaim(jwtWithPayload({ sub: 'patient-a' }));
    const b = readSubjectClaim(jwtWithPayload({ sub: 'patient-b' }));
    expect(a).not.toBe(b);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });
});
