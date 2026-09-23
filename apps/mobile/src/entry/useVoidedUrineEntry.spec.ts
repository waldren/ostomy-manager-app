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
import type { VolumetricValidationThresholds } from '@ostomy/core/validation';

import { checkUrineEntry, hasSomethingToRecord, type UrineDraft } from './useVoidedUrineEntry';

const NOW = new Date('2026-09-23T12:00:00.000Z');
const ENTERED_AT = new Date('2026-09-23T11:00:00.000Z');

/** Injected, never read from a constant in the source under test (AC 13.2 AC2). */
const THRESHOLDS: VolumetricValidationThresholds = {
  softWarningMaxMl: 2000,
  maxClockSkewMs: 300_000,
};

function draft(overrides: Partial<UrineDraft> = {}): UrineDraft {
  return {
    amountText: '',
    method: undefined,
    urineColorCode: undefined,
    effectiveDateTime: ENTERED_AT,
    ...overrides,
  };
}

function check(
  overrides: Partial<UrineDraft> = {},
  measurementSystem: 'metric' | 'imperial' = 'metric',
) {
  return checkUrineEntry({
    draft: draft(overrides),
    measurementSystem,
    thresholds: THRESHOLDS,
    surgeryDate: null,
    now: NOW,
  });
}

describe('hasSomethingToRecord', () => {
  it('is false for an entry carrying neither an amount nor a colour', () => {
    expect(hasSomethingToRecord(draft())).toBe(false);
  });

  it('is true for a colour alone — the case AC 12.1 AC2 exists for', () => {
    expect(hasSomethingToRecord(draft({ urineColorCode: 'amber' }))).toBe(true);
  });

  it('is true for an amount alone', () => {
    expect(hasSomethingToRecord(draft({ amountText: '250' }))).toBe(true);
  });

  /**
   * Whitespace is not an amount. Without the trim, typing a space into the
   * field would enable Save, route the entry to the VOLUMETRIC engine, and
   * block it on `VALUE_NOT_NUMERIC` — a rejection about a number on an entry
   * the patient meant to record as a colour.
   */
  it('treats a whitespace-only amount as no amount', () => {
    expect(hasSomethingToRecord(draft({ amountText: '   ' }))).toBe(false);
  });
});

describe('checkUrineEntry', () => {
  describe('with an amount (AC 12.1 AC1 — identical to the other volumetric screens)', () => {
    it('blocks when the Measured/Estimated toggle is unanswered', () => {
      const result = check({ amountText: '250', method: undefined });

      expect(result).toMatchObject({
        kind: 'blocked',
        errors: [{ ruleCode: 'METHOD_REQUIRED' }],
      });
    });

    it('is ready with an amount and a measured answer', () => {
      expect(check({ amountText: '250', method: 'measured' })).toEqual({ kind: 'ready' });
    });

    it('blocks a non-numeric amount', () => {
      expect(check({ amountText: 'a lot', method: 'measured' })).toMatchObject({
        kind: 'blocked',
        errors: [{ ruleCode: 'VALUE_NOT_NUMERIC' }],
      });
    });

    it('warns above the configured soft maximum rather than blocking', () => {
      expect(check({ amountText: '2500', method: 'measured' })).toMatchObject({
        kind: 'needs-confirmation',
      });
    });

    /**
     * ADR-0004: the thresholds are canonical-mL bounds, so an imperial entry
     * has to be converted BEFORE comparison. 80 oz is 2365.88 mL — over the
     * 2000 mL soft maximum — and an unconverted 80 would silently never warn.
     */
    it('converts an imperial amount to canonical mL before comparing thresholds', () => {
      expect(check({ amountText: '80', method: 'measured' }, 'imperial')).toMatchObject({
        kind: 'needs-confirmation',
      });
    });
  });

  describe('with a colour and no amount (AC 12.1 AC2)', () => {
    it('is ready — the entry this feature exists for', () => {
      expect(check({ urineColorCode: 'amber' })).toEqual({ kind: 'ready' });
    });

    /**
     * `ready`, not `needs-confirmation`. Tier 2's only rule reads a volume,
     * and a warn carrying no warnings would tell the screen to ask "does this
     * look right?" about an entry nothing was found wrong with.
     */
    it('never asks for confirmation, because there is no volume to find implausible', () => {
      expect(check({ urineColorCode: 'brown' })).toEqual({ kind: 'ready' });
    });

    it('still blocks a moment beyond the clock-skew allowance', () => {
      expect(
        check({
          urineColorCode: 'amber',
          effectiveDateTime: new Date('2026-09-23T12:30:00.000Z'),
        }),
      ).toMatchObject({
        kind: 'blocked',
        errors: [{ ruleCode: 'EFFECTIVE_DATE_TIME_IN_FUTURE' }],
      });
    });

    /**
     * The screen hides the toggle when there is no amount, so this is a state
     * the UI does not produce. It is asserted anyway: this is the check that
     * keeps a screen bug from writing a row the local
     * `observations_method_needs_a_value` CHECK would reject as a thrown save
     * rather than as a correctable field.
     */
    it('blocks a Measured/Estimated answer on an entry with no amount', () => {
      expect(check({ urineColorCode: 'amber', method: 'measured' })).toMatchObject({
        kind: 'blocked',
        errors: [{ ruleCode: 'METHOD_NOT_APPLICABLE' }],
      });
    });
  });

  /**
   * D4, unchanged in shape from `checkEntry`: an Estimated entry is a
   * perfectly good clinical record that this software cannot store yet,
   * because no SNOMED qualifier is resolved for it. Reachable only with an
   * amount — without one there is no toggle to answer.
   */
  describe('the Estimated route', () => {
    it('reports estimated-unavailable only while the qualifier is unresolved', () => {
      const result = check({ amountText: '250', method: 'estimated' });

      if (ESTIMATION_METHOD_CODE.resolved) {
        expect(result).toEqual({ kind: 'ready' });
      } else {
        expect(result).toEqual({ kind: 'estimated-unavailable' });
      }
    });
  });

  /**
   * An entry with neither is refused by the server, not by this function.
   * `hasSomethingToRecord` is the screen's affordance; inventing a Tier 1
   * rule here would put a clinical rule in a client, which CLAUDE.md places
   * in `packages/core` and re-enforces server-side.
   */
  it('does not itself block an entry that records nothing', () => {
    expect(check()).toEqual({ kind: 'ready' });
  });
});
