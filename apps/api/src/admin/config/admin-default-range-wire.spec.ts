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

/**
 * The admin default-range wire contract, and the window arithmetic the overlap rule
 * rests on.
 *
 * Outside the integration suite because that one skips itself when Docker is
 * unreachable, and `windowsOverlap` is the function a silent clinical ambiguity depends
 * on: get it wrong and two defaults match the same patient, with §3.9 seeding from
 * whichever the query returned.
 */
import { OstomyType } from '../../generated/prisma/enums';
import { describe, expect, it } from 'vitest';

import {
  OSTOMY_TYPES,
  createDefaultRangeSchema,
  updateDefaultRangeSchema,
  windowsOverlap,
} from './admin-default-range-wire';

const VALID_CREATE = {
  ostomyType: 'ILEOSTOMY' as const,
  rangeType: 'daily_output_ml',
  minDaysPostOp: 0,
  maxDaysPostOp: 30,
  lowValue: 500,
  highValue: 1200,
  unit: 'mL',
  windowDays: null,
};

function rejectCreate(body: unknown): { field: string; rule: string }[] {
  const parsed = createDefaultRangeSchema.safeParse(body);
  expect(parsed.success).toBe(false);
  if (parsed.success) throw new Error('unreachable');
  return parsed.error.issues.map((issue) => ({ field: issue.path.join('.'), rule: issue.code }));
}

/**
 * A window is inclusive at both ends, and `null` is an open end — a null minimum starts
 * at surgery, a null maximum runs forever.
 */
describe('windowsOverlap', () => {
  const w = (minDaysPostOp: number | null, maxDaysPostOp: number | null) => ({
    minDaysPostOp,
    maxDaysPostOp,
  });

  it('is false for windows with a gap between them', async () => {
    expect(windowsOverlap(w(0, 30), w(40, 60))).toBe(false);
  });

  it('is true for windows that straddle', async () => {
    expect(windowsOverlap(w(0, 30), w(15, 60))).toBe(true);
  });

  /**
   * The case a half-open reading would get wrong. Both ends are inclusive, so a patient
   * on day 30 matches `0–30` AND `30–60` — which is precisely the ambiguity the rule
   * exists to prevent, and it is one day wide.
   */
  it('is true for windows that touch at a single day', async () => {
    expect(windowsOverlap(w(0, 30), w(30, 60))).toBe(true);
  });

  it('is true when one window contains the other', async () => {
    expect(windowsOverlap(w(0, 90), w(30, 60))).toBe(true);
  });

  it('treats a null maximum as running forever', async () => {
    expect(windowsOverlap(w(90, null), w(3650, 3700))).toBe(true);
    expect(windowsOverlap(w(0, 30), w(90, null))).toBe(false);
  });

  /**
   * Two unbounded windows always overlap. `Infinity` rather than a large sentinel day
   * number is what makes this true: a finite stand-in would make them look disjoint
   * past it, and "3 months and beyond" twice over is exactly the duplicate a reviewer
   * of a default table would expect to be caught.
   */
  it('is true for two windows that both run forever', async () => {
    expect(windowsOverlap(w(90, null), w(365, null))).toBe(true);
  });

  it('treats a null minimum as starting at surgery', async () => {
    expect(windowsOverlap(w(null, 10), w(0, 5))).toBe(true);
    expect(windowsOverlap(w(null, 10), w(11, 20))).toBe(false);
  });

  it('is true for two fully open windows', async () => {
    expect(windowsOverlap(w(null, null), w(null, null))).toBe(true);
  });
});

describe('creating a default range', () => {
  it('accepts a bounded band', async () => {
    expect(createDefaultRangeSchema.safeParse(VALID_CREATE).success).toBe(true);
  });

  it('accepts a ceiling with no floor', async () => {
    expect(createDefaultRangeSchema.safeParse({ ...VALID_CREATE, lowValue: null }).success).toBe(
      true,
    );
  });

  it('accepts an open-ended window', async () => {
    expect(
      createDefaultRangeSchema.safeParse({ ...VALID_CREATE, maxDaysPostOp: null }).success,
    ).toBe(true);
  });

  it('refuses a range with neither bound, which states nothing', async () => {
    expect(rejectCreate({ ...VALID_CREATE, lowValue: null, highValue: null })).toEqual([
      { field: 'lowValue', rule: 'custom' },
    ]);
  });

  it('refuses a floor above the ceiling', async () => {
    expect(rejectCreate({ ...VALID_CREATE, lowValue: 1200, highValue: 500 })).toEqual([
      { field: 'highValue', rule: 'custom' },
    ]);
  });

  it('refuses a window that ends before it starts', async () => {
    expect(rejectCreate({ ...VALID_CREATE, minDaysPostOp: 60, maxDaysPostOp: 30 })[0]!.field).toBe(
      'maxDaysPostOp',
    );
  });

  it('refuses a negative post-operative day', async () => {
    expect(rejectCreate({ ...VALID_CREATE, minDaysPostOp: -1 })[0]!.field).toBe('minDaysPostOp');
  });

  it('refuses an unknown ostomy type', async () => {
    // v1 is colostomy and ileostomy only. Urostomy was cut because a urostomy's stoma
    // output IS urine, making it a different data model (SRS Appendix A).
    expect(rejectCreate({ ...VALID_CREATE, ostomyType: 'UROSTOMY' })[0]!.field).toBe('ostomyType');
  });

  it('refuses a range type that is not lower snake case', async () => {
    expect(rejectCreate({ ...VALID_CREATE, rangeType: 'Daily-Output' })[0]!.field).toBe(
      'rangeType',
    );
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    expect(rejectCreate({ ...VALID_CREATE, patientId: 'nope' })[0]!.rule).toBe('unrecognized_keys');
  });

  describe('the DECIMAL(12,4) column the bounds are stored in', () => {
    it('refuses a magnitude the column cannot hold', async () => {
      expect(rejectCreate({ ...VALID_CREATE, highValue: 1e8 })[0]!.field).toBe('highValue');
    });

    it('refuses more precision than the column keeps, rather than rounding it', async () => {
      expect(rejectCreate({ ...VALID_CREATE, lowValue: 500.00005 })[0]!.field).toBe('lowValue');
    });
  });
});

describe('updating a default range', () => {
  const VALID_UPDATE = { lowValue: 400, highValue: 1100, windowDays: null };

  it('accepts new bounds', async () => {
    expect(updateDefaultRangeSchema.safeParse(VALID_UPDATE).success).toBe(true);
  });

  /**
   * These three together are WHICH default this is, so editing one turns the row into a
   * different default rather than correcting this one. `.strict()` is what refuses
   * them, and refusing beats ignoring: an admin who sends `maxDaysPostOp` and gets a
   * 200 has every reason to believe the window moved.
   */
  it.each(['ostomyType', 'rangeType', 'minDaysPostOp', 'maxDaysPostOp', 'unit'])(
    'refuses a change to %s, which is part of the row identity',
    async (field) => {
      const parsed = updateDefaultRangeSchema.safeParse({ ...VALID_UPDATE, [field]: 'anything' });
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error('unreachable');
      const issue = parsed.error.issues[0]!;
      expect(issue.code).toBe('unrecognized_keys');
      expect('keys' in issue ? issue.keys : []).toEqual([field]);
    },
  );

  it('still refuses a range with neither bound', async () => {
    const parsed = updateDefaultRangeSchema.safeParse({
      lowValue: null,
      highValue: null,
      windowDays: null,
    });
    expect(parsed.success).toBe(false);
  });
});

/**
 * The wire set mirrors the database enum rather than importing it, the same decision
 * the threshold tiers record — a type the database gains is not automatically a type
 * this API publishes. This is what makes a divergence say so.
 */
describe('the published ostomy types', () => {
  it('match the database enum', async () => {
    expect([...OSTOMY_TYPES].sort()).toEqual(Object.values(OstomyType).sort());
  });
});
