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

import { ESTIMATION_METHOD_CODE } from '@ostomy/core/validation';
import { describe, expect, it } from 'vitest';

import {
  interpretMethodWireValue,
  toMeasuredOrEstimated,
  toStoredMethod,
} from './estimation-method';

describe('Measured/Estimated toggle (AC 2.2, AC 2.5 AC 2)', () => {
  it('reads an explicit null as measured, and stores NULL', () => {
    const interpretation = interpretMethodWireValue(null);
    expect(interpretation).toEqual({ kind: 'measured' });
    expect(toMeasuredOrEstimated(interpretation)).toBe('measured');
    expect(toStoredMethod(interpretation)).toBeNull();
  });

  it('reads an absent key as no selection at all, which Tier 1 then blocks', () => {
    const interpretation = interpretMethodWireValue(undefined);
    expect(interpretation).toEqual({ kind: 'not-selected' });
    // `null` here is what `packages/core`'s `VolumetricEntryInput.method`
    // uses to mean "nothing was selected" — the input that produces
    // METHOD_REQUIRED. It is not the same as the wire's `method: null`,
    // which means "measured"; conflating the two is how a mandatory toggle
    // silently becomes optional.
    expect(toMeasuredOrEstimated(interpretation)).toBeNull();
  });

  it.each([['some-invented-code'], [123], [{ code: 'x' }], [true]])(
    'refuses %s as an unrecognized method',
    (value) => {
      expect(interpretMethodWireValue(value)).toEqual({ kind: 'unrecognized' });
    },
  );
});

describe('D4 — the estimation-technique code is still unresolved', () => {
  /**
   * **This test is a tripwire, and it is supposed to fail when D4 lands.**
   *
   * When `packages/core` publishes `{ resolved: true, code: '<SNOMED code>' }`,
   * this assertion fails and whoever resolved D4 is required to come here,
   * delete it, and assert the new behaviour instead: that
   * `interpretMethodWireValue('<that code>')` returns `{ kind: 'estimated' }`,
   * that `toStoredMethod` returns the code, and that any *other* string is
   * still `unrecognized`. That is the whole change on the server side —
   * `estimation-method.ts` itself needs no edit, because it reads the
   * constant rather than a copy of it.
   *
   * A silent switch-on is the failure mode this prevents: estimated entries
   * would start being accepted and stored with nothing having asserted that
   * the code written to `observations.method` is the right one.
   */
  it('is unresolved, so no non-null method value can be accepted yet', () => {
    expect(ESTIMATION_METHOD_CODE.resolved).toBe(false);
    expect(interpretMethodWireValue('373067005')).toEqual({ kind: 'unrecognized' });
  });
});
