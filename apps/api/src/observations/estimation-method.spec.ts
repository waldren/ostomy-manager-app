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

describe('D4 — the estimation-technique code, now resolved', () => {
  /**
   * This replaces the tripwire that failed the moment `packages/core`
   * published a resolved code. Its job now is the one the tripwire's comment
   * specified: assert that the resolved code is accepted and stored, and that
   * every OTHER string is still refused.
   *
   * `estimation-method.ts` itself needed no edit — it reads the constant
   * rather than a copy of it, which is why resolving D4 was a one-line change
   * in one package rather than a hunt through the server.
   */
  it('accepts the resolved code as an estimated entry', () => {
    expect(ESTIMATION_METHOD_CODE.resolved).toBe(true);
    if (!ESTIMATION_METHOD_CODE.resolved) return;

    expect(interpretMethodWireValue(ESTIMATION_METHOD_CODE.code)).toEqual({
      kind: 'estimated',
      methodCode: ESTIMATION_METHOD_CODE.code,
    });
  });

  it('stores the code itself, so an estimated entry is distinguishable forever after', () => {
    if (!ESTIMATION_METHOD_CODE.resolved) return;

    expect(toStoredMethod(interpretMethodWireValue(ESTIMATION_METHOD_CODE.code))).toBe(
      ESTIMATION_METHOD_CODE.code,
    );
  });

  /**
   * §6.2's "a `method` the server cannot recognize" stays unrepresentable
   * rather than merely unlikely: the only non-null value this surface accepts
   * is the one code `packages/core` published.
   */
  it('still refuses any other SNOMED code, including plausible neighbours', () => {
    expect(interpretMethodWireValue('373067005')).toEqual({ kind: 'unrecognized' });
    // The paired |Measured (qualifier value)| concept. Real, and deliberately
    // NOT accepted: `method: null` is what means measured on this wire
    // (docs/sync-contract.md §7.2), and adopting the code is a separate
    // decision — see ADR-0018's "What this does not change".
    expect(interpretMethodWireValue('258104002')).toEqual({ kind: 'unrecognized' });
  });

  it('still treats null as measured and an absent key as no selection', () => {
    expect(interpretMethodWireValue(null)).toEqual({ kind: 'measured' });
    expect(interpretMethodWireValue(undefined)).toEqual({ kind: 'not-selected' });
  });
});
