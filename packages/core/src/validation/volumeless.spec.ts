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

import { TIER1_RULE_CODE } from './ruleCodes.js';
import type { VolumetricValidationThresholds } from './thresholds.js';
import { isBlocked } from './types.js';
import { validateVolumelessObservation, type VolumelessObservationInput } from './volumeless.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const SURGERY_DATE = new Date('2026-01-01T00:00:00.000Z');

// A test fixture, not an engine constant — the same boundary
// `volumetric.spec.ts` draws.
const THRESHOLDS: VolumetricValidationThresholds = {
  softWarningMaxMl: 2000,
  maxClockSkewMs: 5 * 60 * 1000,
};

function colourOnlyEntry(
  overrides: Partial<VolumelessObservationInput> = {},
): VolumelessObservationInput {
  return {
    field: 'urineColorCode',
    effectiveDateTime: new Date('2026-06-15T09:00:00.000Z'),
    surgeryDate: SURGERY_DATE,
    now: NOW,
    method: null,
    ...overrides,
  };
}

/**
 * The entry this function exists for is a voided-urine record carrying a
 * colour and no amount (SRS §3.7, AC 12.1 AC2) — the case for patients who
 * cannot measure, which is the population whose hydration signal matters
 * most.
 */
describe('validateVolumelessObservation', () => {
  it('accepts an entry with no volume, which the volumetric engine cannot', () => {
    const result = validateVolumelessObservation(colourOnlyEntry(), THRESHOLDS);

    expect(isBlocked(result)).toBe(false);
    expect(result.tier1.outcome).toBe('pass');
  });

  /**
   * `pass`, not `warn` with an empty list. Those are different claims: the
   * second says the entry was examined against the soft-warning rule and
   * found borderline-but-acceptable, which is not true of an entry that has
   * no number for that rule to read.
   */
  it('reports Tier 2 as pass, never a warn carrying no warnings', () => {
    const result = validateVolumelessObservation(colourOnlyEntry(), THRESHOLDS);

    expect(result.tier2.outcome).toBe('pass');
  });

  describe('the timestamp rules still apply', () => {
    it('blocks a moment beyond the clock-skew allowance', () => {
      const result = validateVolumelessObservation(
        colourOnlyEntry({ effectiveDateTime: new Date('2026-06-15T12:06:00.000Z') }),
        THRESHOLDS,
      );

      expect(isBlocked(result)).toBe(true);
      expect(result.tier1).toMatchObject({
        errors: [{ ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_IN_FUTURE }],
      });
    });

    it('blocks a moment before the surgery date', () => {
      const result = validateVolumelessObservation(
        colourOnlyEntry({ effectiveDateTime: new Date('2025-12-31T00:00:00.000Z') }),
        THRESHOLDS,
      );

      expect(isBlocked(result)).toBe(true);
      expect(result.tier1).toMatchObject({
        errors: [{ ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_BEFORE_SURGERY }],
      });
    });

    /**
     * The allowance is injected, never a constant — the same property
     * `no-hardcoded-thresholds.spec.ts` guards for the volumetric engine.
     * Tested with a second value so a hardcoded five minutes would fail.
     */
    it('reads the clock-skew allowance from the injected thresholds', () => {
      const justOverOneMinute = colourOnlyEntry({
        effectiveDateTime: new Date('2026-06-15T12:01:30.000Z'),
      });

      expect(isBlocked(validateVolumelessObservation(justOverOneMinute, THRESHOLDS))).toBe(false);
      expect(
        isBlocked(
          validateVolumelessObservation(justOverOneMinute, {
            ...THRESHOLDS,
            maxClockSkewMs: 60 * 1000,
          }),
        ),
      ).toBe(true);
    });
  });

  /**
   * Measured/Estimated describes how a number was arrived at, so an entry
   * with no number has nothing for it to describe.
   *
   * Reported here rather than left to the database CHECK that also forbids
   * it: a constraint violation surfaces as a 500, and
   * `docs/sync-contract.md` §9 tells a client to re-push a 500
   * indefinitely — so the entry would retry forever instead of reaching the
   * patient's correction inbox.
   */
  describe('METHOD_NOT_APPLICABLE', () => {
    it.each(['measured', 'estimated'] as const)(
      'blocks an entry carrying %s when there is no volume to qualify',
      (method) => {
        const result = validateVolumelessObservation(colourOnlyEntry({ method }), THRESHOLDS);

        expect(isBlocked(result)).toBe(true);
        expect(result.tier1).toMatchObject({
          errors: [{ field: 'urineColorCode', ruleCode: TIER1_RULE_CODE.METHOD_NOT_APPLICABLE }],
        });
      },
    );

    it('reports it alongside a timestamp error rather than short-circuiting', () => {
      const result = validateVolumelessObservation(
        colourOnlyEntry({
          method: 'measured',
          effectiveDateTime: new Date('2025-12-31T00:00:00.000Z'),
        }),
        THRESHOLDS,
      );

      // Both, in §6.2's order. A patient correcting one should not have to
      // save again to discover the other.
      expect(result.tier1).toMatchObject({
        errors: [
          { ruleCode: TIER1_RULE_CODE.METHOD_NOT_APPLICABLE },
          { ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_BEFORE_SURGERY },
        ],
      });
    });
  });
});
