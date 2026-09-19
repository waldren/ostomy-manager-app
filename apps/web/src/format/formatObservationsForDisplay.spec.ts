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

import {
  hasFluidBalanceInputs,
  observationsOnLocalDate,
  toDisplayDailyTotal,
  toDisplayNetFluidBalance,
  toDisplayOutputEntries,
} from './formatObservationsForDisplay.js';

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
    enteredTimezone: 'America/Chicago',
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

describe('observationsOnLocalDate (ADR-0016)', () => {
  function at(effectiveDateTime: string, enteredTimezone: string, code = '79560-9'): Observation {
    return {
      resourceType: 'Observation',
      id: `id-${effectiveDateTime}-${enteredTimezone}`,
      status: 'final',
      code,
      valueQuantity: { value: 100, unit: 'mL' },
      effectiveDateTime,
      method: null,
      enteredMeasurementSystem: 'metric',
      enteredTimezone,
    } as Observation;
  }

  /**
   * The case a UTC-bounded day gets wrong, and the reason this exists: a
   * Chicago evening is the NEXT UTC day, so the old query filed it under
   * tomorrow and showed the patient a total missing it.
   */
  it('keeps a late local evening that falls on the next UTC day', () => {
    const evening = at('2026-09-19T01:00:00.000Z', 'America/Chicago'); // 20:00 on the 18th

    expect(observationsOnLocalDate([evening], '2026-09-18').onDate).toHaveLength(1);
    expect(observationsOnLocalDate([evening], '2026-09-19').onDate).toHaveLength(0);
  });

  /** The mirror: an early local morning east of UTC belongs to the previous UTC day. */
  it('keeps an early local morning that falls on the previous UTC day', () => {
    const morning = at('2026-09-17T22:00:00.000Z', 'Asia/Tokyo'); // 07:00 on the 18th

    expect(observationsOnLocalDate([morning], '2026-09-18').onDate).toHaveLength(1);
  });

  it('files each entry by its own zone, so a travelling patient is not re-filed', () => {
    const chicago = at('2026-09-19T01:00:00.000Z', 'America/Chicago'); // 18th local
    const tokyo = at('2026-09-19T01:00:00.000Z', 'Asia/Tokyo'); // 19th local

    expect(observationsOnLocalDate([chicago, tokyo], '2026-09-18').onDate).toHaveLength(1);
    expect(observationsOnLocalDate([chicago, tokyo], '2026-09-19').onDate).toHaveLength(1);
  });

  /**
   * Excluded rather than defaulted into the viewed day — filing an entry
   * under a day it may not belong to corrupts the figure — but COUNTED, so
   * the page can say so rather than rendering "nothing was recorded".
   */
  it('reports an unresolvable zone instead of silently dropping it', () => {
    const result = observationsOnLocalDate(
      [at('2026-09-18T12:00:00.000Z', 'Mars/Olympus')],
      '2026-09-18',
    );

    expect(result.onDate).toHaveLength(0);
    expect(result.undatable).toBe(1);
  });
});

describe('toDisplayNetFluidBalance (SRS §3.5)', () => {
  function entry(
    code: string,
    valueMl: number,
    system: 'metric' | 'imperial' = 'metric',
  ): Observation {
    return {
      resourceType: 'Observation',
      id: `id-${code}-${valueMl}`,
      status: 'final',
      code,
      valueQuantity: { value: valueMl, unit: 'mL' },
      effectiveDateTime: '2026-09-18T12:00:00.000Z',
      method: null,
      enteredMeasurementSystem: system,
      enteredTimezone: 'UTC',
    } as Observation;
  }

  const metric = unitsForMeasurementSystem('metric');

  it('subtracts output from intake', () => {
    const balance = toDisplayNetFluidBalance(
      [entry('9000-1', 2000), entry('79560-9', 1400)],
      metric,
    );

    expect(balance).toEqual({ value: 600, unit: 'mL' });
  });

  /** An output-dominant day is the classic dehydration presentation; the sign must survive. */
  it('produces a negative balance when output exceeds intake', () => {
    const balance = toDisplayNetFluidBalance(
      [entry('9000-1', 500), entry('79560-9', 1900)],
      metric,
    );

    expect(balance.value).toBe(-1400);
  });

  /**
   * SRS §3.7 / CLAUDE.md: net balance measures stoma losses, while urine
   * output independently signals renal perfusion. Summing them lets a
   * normal-looking balance hide a dangerously low urine output.
   */
  it('excludes voided urine even when passed the whole day undifferentiated', () => {
    const withoutUrine = toDisplayNetFluidBalance(
      [entry('9000-1', 2000), entry('79560-9', 1400)],
      metric,
    );
    const withUrine = toDisplayNetFluidBalance(
      [entry('9000-1', 2000), entry('79560-9', 1400), entry('9187-6', 900)],
      metric,
    );

    expect(withUrine).toEqual(withoutUrine);
  });

  /** ADR-0005: rounded once from canonical values, never summed from rounded figures. */
  it('rounds once, from canonical mL', () => {
    const imperial = unitsForMeasurementSystem('imperial');
    const balance = toDisplayNetFluidBalance(
      [entry('9000-1', 1000), entry('79560-9', 350)],
      imperial,
    );

    // 650 mL converted once, not two separately-rounded oz figures subtracted.
    expect(Number.isInteger(balance.value)).toBe(true);
    expect(balance.unit).toBe('oz');
  });

  it('is zero for a day whose intake and output cancel', () => {
    expect(
      toDisplayNetFluidBalance([entry('9000-1', 800), entry('79560-9', 800)], metric).value,
    ).toBe(0);
  });
});

describe('hasFluidBalanceInputs', () => {
  function ob(code: string): Observation {
    return {
      resourceType: 'Observation',
      id: `id-${code}`,
      status: 'final',
      code,
      valueQuantity: { value: 100, unit: 'mL' },
      effectiveDateTime: '2026-09-18T12:00:00.000Z',
      method: null,
      enteredMeasurementSystem: 'metric',
      enteredTimezone: 'UTC',
    } as Observation;
  }

  it('is false for a day holding only entries the balance ignores', () => {
    expect(hasFluidBalanceInputs([ob('9187-6')])).toBe(false);
  });

  it('is true as soon as either side is present', () => {
    expect(hasFluidBalanceInputs([ob('79560-9')])).toBe(true);
    expect(hasFluidBalanceInputs([ob('9000-1')])).toBe(true);
  });
});
