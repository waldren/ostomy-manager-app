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

import { ozToMl } from '../units/index.js';
import {
  evaluateTier1,
  evaluateTier2,
  hasWarnings,
  isBlocked,
  TIER1_RULE_CODE,
  TIER2_RULE_CODE,
  validateVolumetricEntry,
  type VolumetricEntryInput,
  type VolumetricValidationThresholds,
} from './index.js';

const NOW = new Date('2026-06-15T12:00:00.000Z');
const SURGERY_DATE = new Date('2026-01-01T00:00:00.000Z');

// A test fixture, not an engine constant — see thresholds.ts and
// no-hardcoded-thresholds.spec.ts for the boundary this sprint draws
// between "a threshold the engine reads" (must be injected, tested here
// with more than one value) and "a number a test happens to use."
const THRESHOLDS: VolumetricValidationThresholds = {
  softWarningMaxMl: 2000,
  maxClockSkewMs: 5 * 60 * 1000,
};

function validEntry(overrides: Partial<VolumetricEntryInput> = {}): VolumetricEntryInput {
  return {
    field: 'stomaOutputVolumeMl',
    rawValueMl: 350,
    method: 'measured',
    effectiveDateTime: new Date('2026-06-15T11:00:00.000Z'),
    surgeryDate: SURGERY_DATE,
    now: NOW,
    ...overrides,
  };
}

describe('Tier 1 — hard block on structurally impossible input (SRS §3.8)', () => {
  it('passes a valid entry', () => {
    expect(evaluateTier1(validEntry(), THRESHOLDS)).toEqual({ tier: 'tier1', outcome: 'pass' });
  });

  describe('AC 2.1 AC1 — numeric, positive volume required', () => {
    it('blocks a non-numeric value', () => {
      const result = evaluateTier1(validEntry({ rawValueMl: 'a lot' }), THRESHOLDS);
      expect(result).toMatchObject({
        outcome: 'blocked',
        errors: [{ field: 'stomaOutputVolumeMl', ruleCode: TIER1_RULE_CODE.VALUE_NOT_NUMERIC }],
      });
    });

    it('blocks a missing value', () => {
      const result = evaluateTier1(validEntry({ rawValueMl: undefined }), THRESHOLDS);
      expect(result).toMatchObject({
        outcome: 'blocked',
        errors: [{ ruleCode: TIER1_RULE_CODE.VALUE_NOT_NUMERIC }],
      });
    });

    it('blocks NaN', () => {
      const result = evaluateTier1(validEntry({ rawValueMl: Number.NaN }), THRESHOLDS);
      expect(result).toMatchObject({
        outcome: 'blocked',
        errors: [{ ruleCode: TIER1_RULE_CODE.VALUE_NOT_NUMERIC }],
      });
    });

    it('blocks a negative value', () => {
      const result = evaluateTier1(validEntry({ rawValueMl: -5 }), THRESHOLDS);
      expect(result).toMatchObject({
        outcome: 'blocked',
        errors: [{ ruleCode: TIER1_RULE_CODE.VALUE_NOT_POSITIVE }],
      });
    });

    it('blocks zero — a real 0 mL day is recorded as no entry, not a zero-volume observation', () => {
      const result = evaluateTier1(validEntry({ rawValueMl: 0 }), THRESHOLDS);
      expect(result).toMatchObject({
        outcome: 'blocked',
        errors: [{ ruleCode: TIER1_RULE_CODE.VALUE_NOT_POSITIVE }],
      });
    });

    it('accepts a positive decimal value (ADR-0005 — entry precision is not capped at integers)', () => {
      expect(evaluateTier1(validEntry({ rawValueMl: 123.45 }), THRESHOLDS).outcome).toBe('pass');
    });
  });

  describe('AC 2.2 AC1 — mandatory Measured/Estimated selection', () => {
    it('blocks a missing method', () => {
      const result = evaluateTier1(validEntry({ method: null }), THRESHOLDS);
      expect(result).toMatchObject({
        outcome: 'blocked',
        errors: [{ ruleCode: TIER1_RULE_CODE.METHOD_REQUIRED }],
      });
    });

    it('accepts "measured"', () => {
      expect(evaluateTier1(validEntry({ method: 'measured' }), THRESHOLDS).outcome).toBe('pass');
    });

    it('accepts "estimated"', () => {
      expect(evaluateTier1(validEntry({ method: 'estimated' }), THRESHOLDS).outcome).toBe('pass');
    });
  });

  describe('future timestamps beyond the injected clock-skew allowance', () => {
    it('blocks a timestamp further in the future than the configured allowance', () => {
      const farFuture = new Date(NOW.getTime() + THRESHOLDS.maxClockSkewMs + 60_000);
      const result = evaluateTier1(validEntry({ effectiveDateTime: farFuture }), THRESHOLDS);
      expect(result).toMatchObject({
        outcome: 'blocked',
        errors: [{ ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_IN_FUTURE }],
      });
    });

    it('accepts a timestamp within the configured allowance', () => {
      const withinSkew = new Date(NOW.getTime() + THRESHOLDS.maxClockSkewMs - 1_000);
      const result = evaluateTier1(validEntry({ effectiveDateTime: withinSkew }), THRESHOLDS);
      expect(result.outcome).toBe('pass');
    });

    it('a stricter injected allowance changes the outcome for the same timestamp — proof this is not a hardcoded window', () => {
      const stricter: VolumetricValidationThresholds = { ...THRESHOLDS, maxClockSkewMs: 0 };
      const slightlyFuture = new Date(NOW.getTime() + 30_000);
      expect(
        evaluateTier1(validEntry({ effectiveDateTime: slightlyFuture }), THRESHOLDS).outcome,
      ).toBe('pass');
      expect(
        evaluateTier1(validEntry({ effectiveDateTime: slightlyFuture }), stricter).outcome,
      ).toBe('blocked');
    });
  });

  describe('dates before the surgery date', () => {
    it('blocks a timestamp before the surgery date', () => {
      const beforeSurgery = new Date(SURGERY_DATE.getTime() - 24 * 60 * 60 * 1000);
      const result = evaluateTier1(validEntry({ effectiveDateTime: beforeSurgery }), THRESHOLDS);
      expect(result).toMatchObject({
        outcome: 'blocked',
        errors: [{ ruleCode: TIER1_RULE_CODE.EFFECTIVE_DATE_TIME_BEFORE_SURGERY }],
      });
    });

    it('accepts a timestamp on the surgery date itself', () => {
      const result = evaluateTier1(validEntry({ effectiveDateTime: SURGERY_DATE }), THRESHOLDS);
      expect(result.outcome).toBe('pass');
    });

    it('accepts any timestamp when no surgery date is known yet (onboarding-incomplete patient)', () => {
      const result = evaluateTier1(
        validEntry({
          surgeryDate: null,
          effectiveDateTime: new Date('2000-01-01T00:00:00.000Z'),
        }),
        THRESHOLDS,
      );
      expect(result.outcome).toBe('pass');
    });
  });

  it('collects every violated rule, not just the first', () => {
    const result = evaluateTier1(validEntry({ rawValueMl: -1, method: null }), THRESHOLDS);
    expect(result.outcome).toBe('blocked');
    if (result.outcome === 'blocked') {
      expect(result.errors.map((error) => error.ruleCode).sort()).toEqual(
        [TIER1_RULE_CODE.VALUE_NOT_POSITIVE, TIER1_RULE_CODE.METHOD_REQUIRED].sort(),
      );
    }
  });

  it('never includes the offending value in an error (docs/security-hipaa.md)', () => {
    const result = evaluateTier1(validEntry({ rawValueMl: -2500.5 }), THRESHOLDS);
    expect(JSON.stringify(result)).not.toContain('2500.5');
  });
});

describe('Tier 2 — soft, always-overridable warning on implausible-but-real values', () => {
  it('passes a typical value', () => {
    expect(evaluateTier2(validEntry({ rawValueMl: 350 }), THRESHOLDS)).toEqual({
      tier: 'tier2',
      outcome: 'pass',
    });
  });

  describe('AC 2.1 AC2 — an instance of the injected soft-warning class, not a special case', () => {
    it('warns above the injected threshold', () => {
      const result = evaluateTier2(validEntry({ rawValueMl: 2500 }), THRESHOLDS);
      expect(result).toMatchObject({
        outcome: 'warn',
        warnings: [
          { field: 'stomaOutputVolumeMl', ruleCode: TIER2_RULE_CODE.VALUE_ABOVE_TYPICAL_RANGE },
        ],
      });
    });

    it('does not warn at exactly the threshold', () => {
      const result = evaluateTier2(
        validEntry({ rawValueMl: THRESHOLDS.softWarningMaxMl }),
        THRESHOLDS,
      );
      expect(result.outcome).toBe('pass');
    });

    it('a different injected threshold changes the outcome for the same value — proof this is not hardcoded', () => {
      const stricter: VolumetricValidationThresholds = { ...THRESHOLDS, softWarningMaxMl: 300 };
      expect(evaluateTier2(validEntry({ rawValueMl: 350 }), THRESHOLDS).outcome).toBe('pass');
      expect(evaluateTier2(validEntry({ rawValueMl: 350 }), stricter).outcome).toBe('warn');
    });
  });

  describe('B3 — the comparison has no unit contract of its own; the caller must convert to canonical mL first (ADR-0004)', () => {
    it('warns for an imperial-entered value that converts to canonical mL above the threshold', () => {
      // 80 oz is well over the AC 2.1 AC2 threshold once converted
      // (~2,366 mL against a 2,000 mL ceiling). Comparing the raw imperial
      // number `80` against the mL threshold would wrongly pass — the bug
      // this field's rename and docstring exist to prevent.
      const eightyOzInCanonicalMl = ozToMl(80);
      const result = evaluateTier2(validEntry({ rawValueMl: eightyOzInCanonicalMl }), THRESHOLDS);
      expect(result).toMatchObject({
        outcome: 'warn',
        warnings: [
          { field: 'stomaOutputVolumeMl', ruleCode: TIER2_RULE_CODE.VALUE_ABOVE_TYPICAL_RANGE },
        ],
      });
    });
  });

  it('does not evaluate the magnitude check against a non-numeric value — that is Tier 1s job', () => {
    expect(evaluateTier2(validEntry({ rawValueMl: 'not a number' }), THRESHOLDS)).toEqual({
      tier: 'tier2',
      outcome: 'pass',
    });
  });

  it('never includes the offending value in a warning', () => {
    const result = evaluateTier2(validEntry({ rawValueMl: 999_999 }), THRESHOLDS);
    expect(JSON.stringify(result)).not.toContain('999999');
  });
});

describe('a soft warning never becomes a block (CLAUDE.md: "A warning must never become a block")', () => {
  it('an entry that is Tier-2-implausible but Tier-1-valid is never blocked', () => {
    const result = validateVolumetricEntry(validEntry({ rawValueMl: 5000 }), THRESHOLDS);
    expect(isBlocked(result)).toBe(false);
    expect(hasWarnings(result)).toBe(true);
  });

  it('a Tier 1 block does not suppress Tier 2 information — the two tiers are independent', () => {
    const result = validateVolumetricEntry(
      validEntry({ rawValueMl: 5000, method: null }),
      THRESHOLDS,
    );
    expect(isBlocked(result)).toBe(true);
    expect(hasWarnings(result)).toBe(true);
  });

  it('a fully valid, typical entry is neither blocked nor warned', () => {
    const result = validateVolumetricEntry(validEntry(), THRESHOLDS);
    expect(isBlocked(result)).toBe(false);
    expect(hasWarnings(result)).toBe(false);
  });
});
