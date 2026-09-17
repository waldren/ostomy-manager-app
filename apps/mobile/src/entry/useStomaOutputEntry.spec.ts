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

import {
  amountError,
  checkEntry,
  methodError,
  toCanonicalMl,
  toCanonicalValueString,
} from './useStomaOutputEntry';

const NOW = new Date('2026-09-16T12:00:00.000Z');

/**
 * Injected, never read from a constant in the source under test. These are
 * arbitrary values chosen for the test, which is the point: the rules must
 * follow whatever an admin configured (CLAUDE.md, AC 13.2 AC2).
 */
const THRESHOLDS: VolumetricValidationThresholds = {
  softWarningMaxMl: 2000,
  maxClockSkewMs: 300_000,
};

function check(overrides: {
  amountText?: string;
  method?: 'measured' | 'estimated' | undefined;
  effectiveDateTime?: Date;
  measurementSystem?: 'metric' | 'imperial';
}) {
  return checkEntry({
    draft: {
      amountText: overrides.amountText ?? '350',
      method: 'method' in overrides ? overrides.method : 'measured',
      effectiveDateTime: overrides.effectiveDateTime ?? new Date('2026-09-16T11:00:00.000Z'),
    },
    measurementSystem: overrides.measurementSystem ?? 'metric',
    thresholds: THRESHOLDS,
    surgeryDate: null,
    now: NOW,
  });
}

describe('checkEntry', () => {
  it('accepts an ordinary measured entry', () => {
    expect(check({}).kind).toBe('ready');
  });

  describe('Tier 1 blocks (AC 13.1 AC1, AC 13.1 AC2)', () => {
    it('blocks a non-numeric amount', () => {
      const outcome = check({ amountText: 'about a cup' });

      expect(outcome.kind).toBe('blocked');
      if (outcome.kind !== 'blocked') return;
      expect(amountError(outcome.errors)?.ruleCode).toBe('VALUE_NOT_NUMERIC');
    });

    it('blocks a negative amount', () => {
      const outcome = check({ amountText: '-5' });

      expect(outcome.kind).toBe('blocked');
      if (outcome.kind !== 'blocked') return;
      expect(amountError(outcome.errors)?.ruleCode).toBe('VALUE_NOT_POSITIVE');
    });

    /**
     * A blank field must not report "Enter an amount above 0" — `Number('')`
     * is 0, so a naive parse turns "has not typed anything yet" into a
     * message about a value the patient never entered.
     */
    it('reports a blank amount as not-a-number, not as zero', () => {
      const outcome = check({ amountText: '' });

      expect(outcome.kind).toBe('blocked');
      if (outcome.kind !== 'blocked') return;
      expect(amountError(outcome.errors)?.ruleCode).toBe('VALUE_NOT_NUMERIC');
    });

    /** SRS AC 2.2 AC1: the Measured/Estimated selection is mandatory. */
    it('blocks when the Measured/Estimated toggle is unanswered', () => {
      const outcome = check({ method: undefined });

      expect(outcome.kind).toBe('blocked');
      if (outcome.kind !== 'blocked') return;
      expect(methodError(outcome.errors)?.ruleCode).toBe('METHOD_REQUIRED');
    });

    it('blocks a timestamp beyond the configured clock-skew allowance', () => {
      const outcome = check({ effectiveDateTime: new Date('2026-09-16T13:00:00.000Z') });

      expect(outcome.kind).toBe('blocked');
      if (outcome.kind !== 'blocked') return;
      expect(amountError(outcome.errors)?.ruleCode).toBe('EFFECTIVE_DATE_TIME_IN_FUTURE');
    });

    it('allows a timestamp inside the allowance', () => {
      expect(check({ effectiveDateTime: new Date('2026-09-16T12:02:00.000Z') }).kind).toBe('ready');
    });

    /** The other half of the imperial-conversion regression: it must reach 'ready', not merely avoid a precision error. */
    it('accepts an ordinary imperial entry rather than blocking it on converted precision', () => {
      expect(check({ amountText: '8', measurementSystem: 'imperial' }).kind).toBe('ready');
    });

    it('still blocks a metric amount whose typed precision the column cannot hold', () => {
      const outcome = check({ amountText: '350.12345' });

      expect(outcome.kind).toBe('blocked');
      if (outcome.kind !== 'blocked') return;
      expect(amountError(outcome.errors)?.ruleCode).toBe('VALUE_EXCEEDS_MAX_PRECISION');
    });
  });

  /**
   * Every Tier 1 error carries the same `field`, so routing by field would
   * put the method message under the amount box. These two assertions are
   * what keep that from regressing.
   */
  describe('error routing', () => {
    it('puts METHOD_REQUIRED beside the method control and not the amount', () => {
      const outcome = check({ method: undefined });

      expect(outcome.kind).toBe('blocked');
      if (outcome.kind !== 'blocked') return;
      expect(methodError(outcome.errors)?.ruleCode).toBe('METHOD_REQUIRED');
      expect(amountError(outcome.errors)).toBeUndefined();
    });

    it('puts a value error beside the amount and not the method control', () => {
      const outcome = check({ amountText: '-5' });

      expect(outcome.kind).toBe('blocked');
      if (outcome.kind !== 'blocked') return;
      expect(methodError(outcome.errors)).toBeUndefined();
      expect(amountError(outcome.errors)).toBeDefined();
    });
  });

  describe('Tier 2 (AC 13.2 AC1)', () => {
    it('asks for confirmation above the configured threshold, and never blocks', () => {
      const outcome = check({ amountText: '2500' });

      expect(outcome.kind).toBe('needs-confirmation');
      if (outcome.kind !== 'needs-confirmation') return;
      expect(outcome.warnings[0]?.ruleCode).toBe('VALUE_ABOVE_TYPICAL_RANGE');
    });

    it('does not warn below the threshold', () => {
      expect(check({ amountText: '1999' }).kind).toBe('ready');
    });

    /**
     * The defect `@ostomy/core/validation` records having already been made
     * once: 80 oz is ~2366 mL and must warn. Compared un-converted against a
     * canonical-mL bound it silently never would — for imperial patients
     * only, which is the kind of bug that survives a demo.
     */
    it('converts an imperial amount before comparing against the canonical bound', () => {
      const outcome = check({ amountText: '80', measurementSystem: 'imperial' });

      expect(outcome.kind).toBe('needs-confirmation');
    });
  });

  /**
   * D4. `ESTIMATION_METHOD_CODE` is `{ resolved: false }` and
   * `@ostomy/core/validation` says in as many words not to invent a code, so
   * an Estimated entry cannot be represented — and writing `method: null`
   * would make it indistinguishable from a Measured one, permanently.
   *
   * The assertion is conditional on the union's actual state so that this
   * test becomes a check on the OTHER branch the moment D4 resolves, rather
   * than a failing test someone deletes.
   */
  describe('the Estimated option while D4 is unresolved', () => {
    it('is reported as unavailable rather than as a validation error', () => {
      const outcome = check({ method: 'estimated' });

      if (ESTIMATION_METHOD_CODE.resolved) {
        expect(outcome.kind).toBe('ready');
      } else {
        expect(outcome.kind).toBe('estimated-unavailable');
      }
    });

    it('still blocks first on a Tier 1 error, rather than reporting D4', () => {
      const outcome = check({ method: 'estimated', amountText: '-5' });

      expect(outcome.kind).toBe('blocked');
    });
  });
});

describe('toCanonicalMl', () => {
  it('passes a metric amount through unchanged', () => {
    expect(toCanonicalMl('350', 'metric')).toBe(350);
  });

  it('converts an imperial amount to canonical mL (ADR-0004)', () => {
    expect(Number(toCanonicalMl('80', 'imperial'))).toBeCloseTo(2366, 0);
  });

  /** `VolumetricEntryInput.rawValueMl` is `unknown` so Tier 1 can tell "not a number" from an out-of-range number. Coercing to NaN here would collapse them. */
  it('returns unparseable text as text rather than NaN', () => {
    expect(toCanonicalMl('about a cup', 'metric')).toBe('about a cup');
  });

  it('returns a blank field as blank rather than zero', () => {
    expect(toCanonicalMl('   ', 'metric')).toBe('');
  });
});

describe('toCanonicalValueString', () => {
  /** ADR-0005: stored values keep their entered precision. `Number('350.50')` would store "350.5". */
  it('preserves the typed precision of a metric amount verbatim', () => {
    expect(toCanonicalValueString('350.50', 'metric')).toBe('350.50');
  });

  it('converts an imperial amount, which cannot preserve what was typed', () => {
    const stored = toCanonicalValueString('80', 'imperial');

    expect(stored).toBeDefined();
    expect(Number(stored)).toBeCloseTo(2366, 0);
  });

  /**
   * The regression this exists for: `ozToMl(80)` is `2365.882365`, six
   * fractional digits, which Tier 1 refuses as unstorable in DECIMAL(12,4).
   * Before the conversion was rounded to the column's scale, EVERY imperial
   * entry was blocked — and the message shown was "Use no more than 4 numbers
   * after the decimal point" to a patient who had typed `80`.
   */
  it('rounds a converted value into the canonical column scale, so it is storable', () => {
    const stored = toCanonicalValueString('80', 'imperial');

    expect(stored).toBeDefined();
    const fractionalDigits = (stored ?? '').split('.')[1]?.length ?? 0;
    expect(fractionalDigits).toBeLessThanOrEqual(4);
  });

  it('refuses input that is not a number', () => {
    expect(toCanonicalValueString('about a cup', 'metric')).toBeUndefined();
    expect(toCanonicalValueString('', 'metric')).toBeUndefined();
  });
});
