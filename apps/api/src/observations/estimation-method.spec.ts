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

import { ESTIMATION_METHOD_CODE, MEASURED_METHOD_CODE } from '@ostomy/core/validation';
import { describe, expect, it } from 'vitest';

import {
  interpretMethodWireValue,
  resolveMethodForEntry,
  toMeasuredOrEstimated,
  toStoredMethod,
} from './estimation-method';

describe('Measured/Estimated toggle (AC 2.2, AC 2.5 AC 2)', () => {
  /**
   * ADR-0018's amendment: `null` stays ACCEPTED on the wire, because §8
   * requires understanding a client built before the amendment — but it is
   * normalised before storage, so the ambiguity never reaches a row.
   */
  it('reads an explicit null as measured, and stores the explicit |Measured| code', () => {
    const interpretation = interpretMethodWireValue(null);
    expect(interpretation).toEqual({ kind: 'measured' });
    expect(toMeasuredOrEstimated(interpretation)).toBe('measured');
    expect(toStoredMethod(interpretation)).toBe('258104002');
  });

  it('reads the explicit |Measured| code as measured, and stores it unchanged', () => {
    const interpretation = interpretMethodWireValue('258104002');
    expect(interpretation).toEqual({ kind: 'measured' });
    expect(toMeasuredOrEstimated(interpretation)).toBe('measured');
    expect(toStoredMethod(interpretation)).toBe('258104002');
  });

  /**
   * The point of the amendment: a stored `method` of NULL now means one thing
   * only — this observation has no toggle. Nothing on the volumetric write
   * path may produce it.
   */
  it('never stores NULL for an entry that answered the toggle', () => {
    for (const raw of [null, '258104002', '414135002']) {
      expect(toStoredMethod(interpretMethodWireValue(raw))).not.toBeNull();
    }
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

/**
 * Wire `null` is AMBIGUOUS, and the volume is what disambiguates it.
 *
 * §7.2 requires `method` on every payload, so a client recording a colour with
 * no amount (AC 12.1 AC2) has no way to say "not applicable" except by sending
 * `null`. Reading that as "measured" — correct for a volumetric entry, and what
 * this module did — made every colour-only entry from the mobile app fail
 * `METHOD_NOT_APPLICABLE`, in a correction inbox that shows no toggle for the
 * rule that rejected it. §9.2's retry-unchanged loop, forever.
 */
describe('resolveMethodForEntry — the volume settles what wire null meant', () => {
  it('keeps the measured reading when the entry HAS a volume (§8 back-compat)', () => {
    const resolved = resolveMethodForEntry({ kind: 'measured' }, true, true);

    expect(resolved).toEqual({ kind: 'measured' });
    expect(toMeasuredOrEstimated(resolved)).toBe('measured');
    expect(toStoredMethod(resolved)).toBe(
      MEASURED_METHOD_CODE.resolved ? MEASURED_METHOD_CODE.code : null,
    );
  });

  it('reads it as no-toggle when the entry has NO volume', () => {
    const resolved = resolveMethodForEntry({ kind: 'measured' }, false, true);

    expect(resolved).toEqual({ kind: 'no-toggle' });
    // `null` to the validator, so `validateVolumelessObservation` passes
    // rather than reporting a contradiction the client could not avoid.
    expect(toMeasuredOrEstimated(resolved)).toBeNull();
    // SQL NULL, which is what ADR-0018 (amended) reserves for "this
    // observation has no toggle" — and what
    // `observations_method_needs_a_value` requires.
    expect(toStoredMethod(resolved)).toBeNull();
  });

  /**
   * The rule `METHOD_NOT_APPLICABLE` is actually for: a client asserting a
   * measurement technique for a number it did not supply. That is a
   * contradiction worth reporting, and it stays reported.
   */
  it('leaves an EXPLICIT qualifier alone on a volume-less entry, so it is still rejected', () => {
    const explicitMeasured = resolveMethodForEntry({ kind: 'measured' }, false, false);
    expect(explicitMeasured).toEqual({ kind: 'measured' });
    expect(toMeasuredOrEstimated(explicitMeasured)).toBe('measured');

    const estimated = resolveMethodForEntry(
      { kind: 'estimated', methodCode: '414135002' },
      false,
      false,
    );
    expect(toMeasuredOrEstimated(estimated)).toBe('estimated');
  });

  it('leaves an absent key alone — a volume-less entry may simply omit it', () => {
    expect(resolveMethodForEntry({ kind: 'not-selected' }, false, false)).toEqual({
      kind: 'not-selected',
    });
    expect(toMeasuredOrEstimated({ kind: 'not-selected' })).toBeNull();
  });
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
    // `373067005` |No| — a real qualifier, and nothing this field means.
    expect(interpretMethodWireValue('373067005')).toEqual({ kind: 'unrecognized' });
    expect(interpretMethodWireValue('')).toEqual({ kind: 'unrecognized' });
    // Not a code at all. §6.2's "a `method` the server cannot recognize"
    // stays unrepresentable rather than merely unlikely: the only non-null
    // values this surface accepts are the two `packages/core` published.
    expect(interpretMethodWireValue('measured')).toEqual({ kind: 'unrecognized' });
  });

  it('accepts exactly two non-null codes, and no others', () => {
    const accepted = ['258104002', '414135002'];
    for (const code of accepted) {
      expect(interpretMethodWireValue(code)).not.toEqual({ kind: 'unrecognized' });
    }
    for (const code of ['258104003', '414135003', '4141350020']) {
      expect(interpretMethodWireValue(code)).toEqual({ kind: 'unrecognized' });
    }
  });

  it('still treats null as measured and an absent key as no selection', () => {
    expect(interpretMethodWireValue(null)).toEqual({ kind: 'measured' });
    expect(interpretMethodWireValue(undefined)).toEqual({ kind: 'not-selected' });
  });
});
