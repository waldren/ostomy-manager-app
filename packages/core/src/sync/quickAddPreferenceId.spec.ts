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

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { utf8, uuidV5FromSha1, uuidV5HashInput } from '../uuid/uuidV5.js';

import {
  quickAddPreferenceId,
  quickAddRoutineKey,
  type QuickAddRoutine,
} from './quickAddPreferenceId.js';

const sha1 = (input: Uint8Array) => new Uint8Array(createHash('sha1').update(input).digest());

const ROUTINE: QuickAddRoutine = {
  code: '79560-9',
  valueMl: 350,
  method: '258104002',
  fluidTypeCode: null,
  urineColorCode: null,
  enteredMeasurementSystem: 'metric',
};
const PROFILE_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

/**
 * The id of a Quick-Add decision (P4.S3 slice 5, §7.7). The phone and the
 * server each derive it with their own SHA-1, so both must produce a standard
 * UUIDv5 — which the RFC's own example pins.
 */
describe('quickAddPreferenceId', () => {
  /** RFC 9562 Appendix A.4: v5 of "www.example.com" in the DNS namespace. */
  it('is a standard UUIDv5', () => {
    const dns = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

    expect(uuidV5FromSha1(sha1(uuidV5HashInput(dns, 'www.example.com')))).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('is the same for the same routine and profile, whichever side derives it', async () => {
    const asyncSha1 = (input: Uint8Array) => Promise.resolve(sha1(input));

    expect(await quickAddPreferenceId(PROFILE_ID, ROUTINE, asyncSha1)).toBe(
      await quickAddPreferenceId(PROFILE_ID, { ...ROUTINE }, sha1),
    );
  });

  it('differs between two patients with the same routine', async () => {
    const other = '0a1b2c3d-4e5f-4061-8728-394a5b6c7d8e';

    expect(await quickAddPreferenceId(PROFILE_ID, ROUTINE, sha1)).not.toBe(
      await quickAddPreferenceId(other, ROUTINE, sha1),
    );
  });

  it.each([
    ['volume', { valueMl: 355 }],
    ['Measured/Estimated', { method: '414135002' }],
    ['fluid type', { fluidTypeCode: 'water' }],
    ['urine colour', { urineColorCode: 'pale' }],
    ['entry system', { enteredMeasurementSystem: 'imperial' as const }],
    ['code', { code: '9000-1' }],
  ])('differs when the %s differs, so a decision names exactly one widget', async (_f, change) => {
    expect(await quickAddPreferenceId(PROFILE_ID, ROUTINE, sha1)).not.toBe(
      await quickAddPreferenceId(PROFILE_ID, { ...ROUTINE, ...change }, sha1),
    );
  });
});

describe('quickAddRoutineKey', () => {
  /** The phone stores what was typed ("350.50"); the server a decimal. Both name one routine. */
  it('names a volume by its number, not by how it was written', () => {
    expect(quickAddRoutineKey({ ...ROUTINE, valueMl: Number('350.50') })).toBe(
      quickAddRoutineKey({ ...ROUTINE, valueMl: 350.5 }),
    );
  });

  it('keeps an absent volume apart from a zero one', () => {
    expect(quickAddRoutineKey({ ...ROUTINE, valueMl: null })).not.toBe(
      quickAddRoutineKey({ ...ROUTINE, valueMl: 0 }),
    );
  });
});

/** This package cannot use `TextEncoder` (it has no DOM or Node types), so its encoder is checked against Node's. */
describe('utf8', () => {
  it.each(['pale_yellow', 'café', '水分', '😀 ok', '\ud800 lone'])(
    'encodes %j as Node does',
    (text) => {
      expect(Array.from(utf8(text))).toEqual(Array.from(Buffer.from(text, 'utf8')));
    },
  );
});
