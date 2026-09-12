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

import { unitsForMeasurementSystem } from '@ostomy/core/units';
import type { Observation } from '@ostomy/core/api-client';
import { describe, expect, it } from 'vitest';

import { toDisplayDailyTotal, toDisplayOutputEntries } from './formatObservationsForDisplay.js';

function observation(overrides: Partial<Observation>): Observation {
  return {
    resourceType: 'Observation',
    id: 'obs-1',
    status: 'final',
    code: '79560-9',
    valueQuantity: { value: 100, unit: 'mL' },
    effectiveDateTime: '2026-09-11T08:00:00.000Z',
    method: null,
    enteredMeasurementSystem: 'metric',
    ...overrides,
  };
}

describe('toDisplayOutputEntries', () => {
  it('sorts entries chronologically, earliest first, regardless of input order', () => {
    const entries = toDisplayOutputEntries(
      [
        observation({ id: 'b', effectiveDateTime: '2026-09-11T14:00:00.000Z' }),
        observation({ id: 'a', effectiveDateTime: '2026-09-11T08:00:00.000Z' }),
      ],
      unitsForMeasurementSystem('metric'),
    );
    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b']);
  });

  it('maps a null method to "measured" and a non-null method to "estimated" (CLAUDE.md)', () => {
    const entries = toDisplayOutputEntries(
      [
        observation({ id: 'measured', method: null }),
        observation({ id: 'estimated', method: '373098007' }),
      ],
      unitsForMeasurementSystem('metric'),
    );
    expect(entries.find((entry) => entry.id === 'measured')?.method).toBe('measured');
    expect(entries.find((entry) => entry.id === 'estimated')?.method).toBe('estimated');
  });

  it('does not round a same-system metric readback (AC 2.1 AC4)', () => {
    const entries = toDisplayOutputEntries(
      [
        observation({
          valueQuantity: { value: 123.456, unit: 'mL' },
          enteredMeasurementSystem: 'metric',
        }),
      ],
      unitsForMeasurementSystem('metric'),
    );
    expect(entries[0]?.display).toEqual({ value: 123.456, unit: 'mL' });
  });

  it('rounds to the nearest whole unit on a genuine cross-system conversion (AC 2.1 AC4)', () => {
    const entries = toDisplayOutputEntries(
      [
        observation({
          valueQuantity: { value: 236.588, unit: 'mL' },
          enteredMeasurementSystem: 'metric',
        }),
      ],
      unitsForMeasurementSystem('imperial'),
    );
    expect(entries[0]?.display.unit).toBe('oz');
    expect(Number.isInteger(entries[0]?.display.value)).toBe(true);
  });
});

describe('toDisplayDailyTotal', () => {
  it('sums canonical values and rounds once, not the sum of rounded per-entry figures (ADR-0005)', () => {
    // Two entries whose individually-rounded oz figures would sum differently
    // than the true canonical total rounded once.
    const total = toDisplayDailyTotal(
      [
        observation({ id: '1', valueQuantity: { value: 10, unit: 'mL' } }),
        observation({ id: '2', valueQuantity: { value: 10, unit: 'mL' } }),
      ],
      unitsForMeasurementSystem('imperial'),
    );
    // 20 mL total, converted once: not 1 oz (10 mL rounds to 0 oz twice, sum 0).
    expect(total.unit).toBe('oz');
    expect(total.value).toBeGreaterThan(0);
  });

  it('leaves a same-system total unrounded, because nothing was converted', () => {
    // ADR-0005's whole-unit rounding applies to a CONVERSION. A metric
    // patient reading a metric total is reading back what was entered, and
    // rounding it would discard precision the record actually holds.
    const total = toDisplayDailyTotal(
      [
        observation({ id: '1', valueQuantity: { value: 12.5, unit: 'mL' } }),
        observation({ id: '2', valueQuantity: { value: 10.25, unit: 'mL' } }),
      ],
      unitsForMeasurementSystem('metric'),
    );
    expect(total).toEqual({ value: 22.75, unit: 'mL' });
  });

  it('rounds a total for a day that mixes entered systems, in either display system', () => {
    // A patient who switched preference mid-day. There is no single
    // same-system readback for the total, so it is a converted figure by
    // definition and ADR-0005's rounding applies.
    //
    // This was previously achieved by handing the converter the OPPOSITE of
    // the target system — a system no entry was recorded in — which meant
    // the rounding depended on a fabricated data value rather than on a
    // stated decision. Asserting on both display systems is what makes this
    // test independent of that mechanism: the old trick and the current
    // explicit rounding are only distinguishable if metric is checked too.
    const mixedDay = [
      observation({
        id: '1',
        valueQuantity: { value: 12.5, unit: 'mL' },
        enteredMeasurementSystem: 'metric',
      }),
      observation({
        id: '2',
        valueQuantity: { value: 10.25, unit: 'mL' },
        enteredMeasurementSystem: 'imperial',
      }),
    ];

    const metricTotal = toDisplayDailyTotal(mixedDay, unitsForMeasurementSystem('metric'));
    expect(metricTotal.unit).toBe('mL');
    expect(Number.isInteger(metricTotal.value)).toBe(true);
    expect(metricTotal.value).toBe(23);

    const imperialTotal = toDisplayDailyTotal(mixedDay, unitsForMeasurementSystem('imperial'));
    expect(imperialTotal.unit).toBe('oz');
    expect(Number.isInteger(imperialTotal.value)).toBe(true);
  });

  it('returns an exact metric total with no entries at all', () => {
    const total = toDisplayDailyTotal([], unitsForMeasurementSystem('metric'));
    expect(total).toEqual({ value: 0, unit: 'mL' });
  });
});
