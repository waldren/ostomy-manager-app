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

import { en } from './index.js';
import { rangeBandKey, rangeBasisCopy, rangeTypeLabelKey } from './targetRangeCopy.js';

/** The key without its namespace prefix, as `en.common` indexes it. */
const inCommon = (key: string) => key.replace(/^common:/, '') as keyof typeof en.common;

/**
 * Which target-range strings both clients choose (P4.S3 slice 4). One choice,
 * so the phone and the web cannot describe the same patient's day differently.
 */
describe('target range copy selection', () => {
  it.each([
    [0, 'targetRanges.basisEarly', undefined],
    [14, 'targetRanges.basisEarly', undefined],
    [15, 'targetRanges.basisMonths', 1],
    [90, 'targetRanges.basisMonths', 3],
    [164, 'targetRanges.basisMonths', 5],
    [165, 'targetRanges.basisSettled', undefined],
    [2000, 'targetRanges.basisSettled', undefined],
  ])('day %i after surgery reads as %s', (daysPostOp, key, months) => {
    const copy = rangeBasisCopy({ ostomyType: 'ileostomy', daysPostOp });

    expect(copy.key).toBe(`common:${key}`);
    expect(copy.months).toBe(months);
  });

  it('names the ostomy type with its own article', () => {
    expect(rangeBasisCopy({ ostomyType: 'colostomy', daysPostOp: 0 }).ostomyTypeKey).toBe(
      'common:ostomyType.colostomyLower',
    );
  });

  it('labels the known range types, and anything else as another measure', () => {
    expect(rangeTypeLabelKey('urine_output_adequacy_ml')).toBe(
      'common:rangeType.urine_output_adequacy_ml',
    );
    expect(rangeTypeLabelKey('toString')).toBe('common:rangeType.unknownMeasure');
  });

  it('picks the band sentence from which bounds exist', () => {
    expect(rangeBandKey({ hasLow: true, hasHigh: true })).toBe('common:targetRanges.band');
    expect(rangeBandKey({ hasLow: true, hasHigh: false })).toBe('common:targetRanges.atLeast');
    expect(rangeBandKey({ hasLow: false, hasHigh: true })).toBe('common:targetRanges.atMost');
    expect(rangeBandKey({ hasLow: false, hasHigh: false })).toBeNull();
  });

  it('chooses only keys the catalog has', () => {
    const chosen = [
      rangeTypeLabelKey('daily_output_ml'),
      rangeTypeLabelKey('net_fluid_balance_ml'),
      rangeTypeLabelKey('unknown'),
      rangeBasisCopy({ ostomyType: 'ileostomy', daysPostOp: 0 }).key,
      rangeBasisCopy({ ostomyType: 'ileostomy', daysPostOp: 60 }).key,
      rangeBasisCopy({ ostomyType: 'ileostomy', daysPostOp: 999 }).key,
      rangeBasisCopy({ ostomyType: 'colostomy', daysPostOp: 0 }).ostomyTypeKey,
      rangeBasisCopy({ ostomyType: 'ileostomy', daysPostOp: 0 }).ostomyTypeKey,
    ];
    for (const key of chosen) expect(en.common[inCommon(key)], key).toBeTypeOf('string');
  });
});
