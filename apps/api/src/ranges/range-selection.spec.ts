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

import {
  daysSinceSurgery,
  divergesFromPhysicianValue,
  isSuggestableRangeType,
  pickWindowForDay,
  resolveEffectiveRange,
  type RangeProvenanceName,
} from './range-selection';

function candidate(
  provenance: RangeProvenanceName,
  overrides: { status?: string; clientUpdatedAt?: string } = {},
) {
  return {
    provenance,
    status: overrides.status ?? 'ACTIVE',
    clientUpdatedAt: new Date(overrides.clientUpdatedAt ?? '2026-10-01T00:00:00.000Z'),
  };
}

describe('daysSinceSurgery', () => {
  it('counts whole days between two calendar dates', () => {
    expect(daysSinceSurgery('2026-09-01', '2026-10-09')).toBe(38);
  });

  it('is zero on the day of surgery', () => {
    expect(daysSinceSurgery('2026-10-09', '2026-10-09')).toBe(0);
  });

  /**
   * Both sides are calendar dates, so a DST transition between them must not
   * shift the count. Computing this from local instants would: a spring-forward
   * day is 23 hours, and `Math.floor` over a 23-hour day loses one.
   */
  it('is unaffected by a daylight-saving transition in between', () => {
    // 2026-03-08 is the US spring-forward date; a local-time calculation across
    // it would come out at 30 rather than 31.
    expect(daysSinceSurgery('2026-02-20', '2026-03-23')).toBe(31);
  });

  it('goes negative for a surgery date in the future, rather than clamping', () => {
    // Onboarding refuses one, so this is unreachable through the app — and it
    // returning a negative rather than 0 is what makes `pickWindowForDay` find
    // no window instead of silently handing back the day-0 suggestion.
    expect(daysSinceSurgery('2026-10-20', '2026-10-09')).toBe(-11);
  });
});

describe('pickWindowForDay', () => {
  const windows = [
    { rangeType: 'daily_output_ml', minDaysPostOp: 0, maxDaysPostOp: 30 },
    { rangeType: 'daily_output_ml', minDaysPostOp: 31, maxDaysPostOp: 90 },
    { rangeType: 'daily_output_ml', minDaysPostOp: 91, maxDaysPostOp: null },
  ];

  /** Both bounds inclusive — the semantics #97's `int4range(... + 1)` encodes. */
  it.each([
    [0, 0],
    [30, 0],
    [31, 1],
    [90, 1],
    [91, 2],
    [4000, 2],
  ])('day %i falls in window %i', (daysPostOp, index) => {
    expect(pickWindowForDay(windows, daysPostOp)).toBe(windows[index]);
  });

  it('finds nothing for a negative day, so a future surgery date yields no suggestion', () => {
    expect(pickWindowForDay(windows, -1)).toBeUndefined();
  });

  it('finds nothing when a range type has no defaults seeded — weight and heart rate, until P6/P7', () => {
    expect(pickWindowForDay([], 10)).toBeUndefined();
  });

  /**
   * A NULL `min_days_post_op` means "from day 0", which is what #97's exclusion
   * constraint encodes as `COALESCE("min_days_post_op", 0)`.
   *
   * The column is nullable and the model's doc comment explains only the NULL
   * max case. Read as non-null — which the first version of this module did —
   * `daysPostOp >= null` is false and the row matches NO day, so the patient
   * silently gets no suggestion rather than an error.
   */
  it('treats a null lower bound as day 0, exactly as the database constraint does', () => {
    const open = [{ rangeType: 'daily_output_ml', minDaysPostOp: null, maxDaysPostOp: 30 }];

    expect(pickWindowForDay(open, 0)).toBe(open[0]);
    expect(pickWindowForDay(open, 30)).toBe(open[0]);
    expect(pickWindowForDay(open, 31)).toBeUndefined();
  });
});

describe('resolveEffectiveRange', () => {
  /** §3.9's order, highest first. */
  it.each([
    [['PATIENT_SET', 'PHYSICIAN_SET'], 'PHYSICIAN_SET'],
    [['PATIENT_CONFIRMED_SUGGESTION', 'PATIENT_SET'], 'PATIENT_SET'],
    [['CLINICAL_DEFAULT', 'PATIENT_CONFIRMED_SUGGESTION'], 'PATIENT_CONFIRMED_SUGGESTION'],
    [['CLINICAL_DEFAULT'], 'CLINICAL_DEFAULT'],
  ])('resolves %s to %s', (provenances, expected) => {
    const candidates = (provenances as RangeProvenanceName[]).map((p) => candidate(p));
    expect(resolveEffectiveRange(candidates)?.provenance).toBe(expected);
  });

  it('is order-independent', () => {
    const physician = candidate('PHYSICIAN_SET');
    const patient = candidate('PATIENT_SET');

    expect(resolveEffectiveRange([physician, patient])).toBe(physician);
    expect(resolveEffectiveRange([patient, physician])).toBe(physician);
  });

  /**
   * AC 2, and the single most important case in this file: "No value becomes an
   * active threshold without a human confirming it." A PROPOSED row is persisted
   * so Preferences can list it (§3.10) — being stored must not make it apply.
   */
  it.each(['PROPOSED', 'SUPERSEDED', 'DISMISSED'])('never selects a %s row', (status) => {
    expect(resolveEffectiveRange([candidate('PHYSICIAN_SET', { status })])).toBeUndefined();
  });

  it('ignores a PROPOSED row of higher precedence than an ACTIVE one', () => {
    const result = resolveEffectiveRange([
      candidate('PHYSICIAN_SET', { status: 'PROPOSED' }),
      candidate('PATIENT_SET'),
    ]);

    expect(result?.provenance).toBe('PATIENT_SET');
  });

  it('returns nothing when the patient has no ranges at all', () => {
    expect(resolveEffectiveRange([])).toBeUndefined();
  });

  /**
   * Two ACTIVE rows of one provenance is unreachable through this app's writes
   * once the partial unique index exists, and the tie-break is still defined
   * rather than left to row order — a patient's effective threshold depending on
   * which row the query returned first is the kind of non-determinism nobody
   * notices until two readers disagree.
   */
  it('breaks a same-provenance tie on the newer value, not on row order', () => {
    const older = candidate('PATIENT_SET', { clientUpdatedAt: '2026-09-01T00:00:00.000Z' });
    const newer = candidate('PATIENT_SET', { clientUpdatedAt: '2026-10-01T00:00:00.000Z' });

    expect(resolveEffectiveRange([older, newer])).toBe(newer);
    expect(resolveEffectiveRange([newer, older])).toBe(newer);
  });
});

describe('divergesFromPhysicianValue', () => {
  /**
   * AC 4: the physician's value stays in force and the divergence is FLAGGED.
   * Both halves matter — `resolveEffectiveRange` keeps the physician's value,
   * and this is what lets a surface say the patient's own number is not the one
   * being used, instead of silently showing a value they did not choose.
   */
  it('reports a patient value sitting alongside a physician one', () => {
    expect(divergesFromPhysicianValue([candidate('PHYSICIAN_SET'), candidate('PATIENT_SET')])).toBe(
      true,
    );
  });

  it('counts a confirmed suggestion as a patient value', () => {
    expect(
      divergesFromPhysicianValue([
        candidate('PHYSICIAN_SET'),
        candidate('PATIENT_CONFIRMED_SUGGESTION'),
      ]),
    ).toBe(true);
  });

  it('reports nothing when only one of the two exists', () => {
    expect(divergesFromPhysicianValue([candidate('PHYSICIAN_SET')])).toBe(false);
    expect(divergesFromPhysicianValue([candidate('PATIENT_SET')])).toBe(false);
  });

  /** A proposal is not a divergence: nobody has chosen it yet. */
  it('ignores a PROPOSED patient value', () => {
    expect(
      divergesFromPhysicianValue([
        candidate('PHYSICIAN_SET'),
        candidate('PATIENT_SET', { status: 'PROPOSED' }),
      ]),
    ).toBe(false);
  });
});

describe('isSuggestableRangeType', () => {
  /**
   * The consumer `SAFETY_RANGE_TYPES` was added without. `heart_rate_red_flag_bpm`
   * lives in `clinical_default_ranges` (#94) and is not patient-adjustable; the
   * table has no `patient_adjustable` column, so the property is structural —
   * the row exists and nothing derives a patient range from it.
   */
  it('refuses the heart-rate red flag, which is a safety bound rather than a target', () => {
    expect(isSuggestableRangeType('heart_rate_red_flag_bpm')).toBe(false);
  });

  it.each(['daily_output_ml', 'urine_output_adequacy_ml', 'net_fluid_balance_ml'])(
    'allows %s',
    (rangeType) => {
      expect(isSuggestableRangeType(rangeType)).toBe(true);
    },
  );
});
