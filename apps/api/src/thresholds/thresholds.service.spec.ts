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

import { describe, expect, it, vi } from 'vitest';

import { THRESHOLD_KEY, ThresholdsService, type ActiveValueSetMember } from './thresholds.service';

/** A minimal stand-in for a Prisma `Decimal` — only `.toNumber()` is ever called on it by this service. */
function decimal(value: number) {
  return { toNumber: () => value };
}

function fakePrismaWithThresholds(
  overrides: {
    softWarningMaxMl?: number;
    clockSkewSeconds?: number;
    // S3 (P1.S5 review response): defaults match what
    // `RequiredVolumetricThreshold` in thresholds.service.ts expects — a
    // test that wants to prove the unit/tier check fires overrides one of
    // these to something else.
    softWarningUnit?: string;
    softWarningTier?: string;
    clockSkewUnit?: string;
    clockSkewTier?: string;
  } = {},
) {
  const softWarningMaxMl = overrides.softWarningMaxMl ?? 2000;
  const clockSkewSeconds = overrides.clockSkewSeconds ?? 300;

  return {
    validationThreshold: {
      findMany: vi.fn().mockResolvedValue([
        {
          thresholdKey: THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML,
          value: decimal(softWarningMaxMl),
          unit: overrides.softWarningUnit ?? 'mL',
          tier: overrides.softWarningTier ?? 'TIER_2_SOFT_WARNING',
        },
        {
          thresholdKey: THRESHOLD_KEY.SYNC_CLOCK_SKEW_ALLOWANCE_SECONDS,
          value: decimal(clockSkewSeconds),
          unit: overrides.clockSkewUnit ?? 'seconds',
          tier: overrides.clockSkewTier ?? 'OPERATIONAL',
        },
      ]),
    },
    valueSet: { findUnique: vi.fn() },
    valueSetMember: { findMany: vi.fn() },
  };
}

describe('ThresholdsService.getVolumetricThresholds()', () => {
  it('produces the exact VolumetricValidationThresholds shape packages/core defines, converting seconds to ms', async () => {
    const prisma = fakePrismaWithThresholds({ softWarningMaxMl: 2000, clockSkewSeconds: 300 });
    const service = new ThresholdsService(prisma as never, 60_000);

    const thresholds = await service.getVolumetricThresholds();

    expect(thresholds).toEqual({ softWarningMaxMl: 2000, maxClockSkewMs: 300_000 });
  });

  it('reads thresholds as injected data, not a hardcoded bound — parameterized over the underlying row value', async () => {
    const prisma = fakePrismaWithThresholds({ softWarningMaxMl: 1500 });
    const service = new ThresholdsService(prisma as never, 60_000);

    const thresholds = await service.getVolumetricThresholds();

    expect(thresholds.softWarningMaxMl).toBe(1500);
  });

  it('throws when a required threshold row is missing, rather than silently defaulting', async () => {
    const prisma = {
      validationThreshold: { findMany: vi.fn().mockResolvedValue([]) },
    };
    const service = new ThresholdsService(prisma as never, 60_000);

    await expect(service.getVolumetricThresholds()).rejects.toThrow(/missing required/);
  });

  it("throws the SAME missing-row error when a row exists but its unit does not match what this service expects (S3) — e.g. an admin edit from 'mL' to 'L'", async () => {
    const prisma = fakePrismaWithThresholds({ softWarningUnit: 'L' });
    const service = new ThresholdsService(prisma as never, 60_000);

    await expect(service.getVolumetricThresholds()).rejects.toThrow(/missing required/);
  });

  it('throws the SAME missing-row error when a row exists but its tier does not match what this service expects (S3) — e.g. re-tiered from soft warning to hard block', async () => {
    const prisma = fakePrismaWithThresholds({ softWarningTier: 'TIER_1_HARD_BLOCK' });
    const service = new ThresholdsService(prisma as never, 60_000);

    await expect(service.getVolumetricThresholds()).rejects.toThrow(/missing required/);
  });

  it('throws when the clock-skew row is seeded in the wrong unit (S3) — e.g. minutes instead of seconds would silently multiply the allowance by 60 if unchecked', async () => {
    const prisma = fakePrismaWithThresholds({ clockSkewUnit: 'minutes' });
    const service = new ThresholdsService(prisma as never, 60_000);

    await expect(service.getVolumetricThresholds()).rejects.toThrow(/missing required/);
  });

  it('caches the result within the TTL — a second call inside the TTL does not re-query', async () => {
    const prisma = fakePrismaWithThresholds();
    const service = new ThresholdsService(prisma as never, 60_000);

    await service.getVolumetricThresholds();
    await service.getVolumetricThresholds();

    expect(prisma.validationThreshold.findMany).toHaveBeenCalledTimes(1);
  });

  it('re-queries once the TTL elapses', async () => {
    vi.useFakeTimers();
    try {
      const prisma = fakePrismaWithThresholds();
      const service = new ThresholdsService(prisma as never, 1_000);

      await service.getVolumetricThresholds();
      vi.advanceTimersByTime(1_001);
      await service.getVolumetricThresholds();

      expect(prisma.validationThreshold.findMany).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidate() picks up a changed row immediately, with no restart and without waiting out the TTL (AC 13.2 AC2's enabling requirement)", async () => {
    const prisma = fakePrismaWithThresholds({ softWarningMaxMl: 2000 });
    const service = new ThresholdsService(prisma as never, 60 * 60 * 1000);

    const before = await service.getVolumetricThresholds();
    expect(before.softWarningMaxMl).toBe(2000);

    // Simulate an admin config write changing the underlying row (P3.S3,
    // not built yet) — same fake Prisma client, new resolved value.
    prisma.validationThreshold.findMany.mockResolvedValueOnce([
      {
        thresholdKey: THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML,
        value: decimal(1800),
        unit: 'mL',
        tier: 'TIER_2_SOFT_WARNING',
      },
      {
        thresholdKey: THRESHOLD_KEY.SYNC_CLOCK_SKEW_ALLOWANCE_SECONDS,
        value: decimal(300),
        unit: 'seconds',
        tier: 'OPERATIONAL',
      },
    ]);

    service.invalidate();
    const after = await service.getVolumetricThresholds();

    expect(after.softWarningMaxMl).toBe(1800);
    expect(prisma.validationThreshold.findMany).toHaveBeenCalledTimes(2);
  });
});

describe('ThresholdsService.getActiveValueSetMembers()', () => {
  it('returns only ACTIVE members, ordered by sortOrder, never a retired one', async () => {
    const prisma = {
      validationThreshold: { findMany: vi.fn() },
      valueSet: { findUnique: vi.fn().mockResolvedValue({ id: 'value-set-1', key: 'fluid_type' }) },
      valueSetMember: {
        findMany: vi.fn().mockResolvedValue([
          { code: 'water', sortOrder: 0, numericValue: null, numericUnit: null },
          { code: 'juice', sortOrder: 1, numericValue: null, numericUnit: null },
        ]),
      },
    };
    const service = new ThresholdsService(prisma as never, 60_000);

    const members = await service.getActiveValueSetMembers('fluid_type');

    expect(members).toEqual([
      { code: 'water', sortOrder: 0, numericValue: null, numericUnit: null },
      { code: 'juice', sortOrder: 1, numericValue: null, numericUnit: null },
    ]);
    expect(prisma.valueSetMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'ACTIVE' }) }),
    );
  });

  it('throws when no value set is registered under the given key', async () => {
    const prisma = {
      validationThreshold: { findMany: vi.fn() },
      valueSet: { findUnique: vi.fn().mockResolvedValue(null) },
      valueSetMember: { findMany: vi.fn() },
    };
    const service = new ThresholdsService(prisma as never, 60_000);

    await expect(service.getActiveValueSetMembers('nonexistent')).rejects.toThrow(
      /no value set registered/,
    );
  });

  it("returns a fresh array each call, never the cached array by reference (S5) — mutating one caller's result must not poison the next caller's read", async () => {
    const prisma = {
      validationThreshold: { findMany: vi.fn() },
      valueSet: { findUnique: vi.fn().mockResolvedValue({ id: 'value-set-1', key: 'fluid_type' }) },
      valueSetMember: {
        findMany: vi.fn().mockResolvedValue([
          { code: 'water', sortOrder: 0, numericValue: null, numericUnit: null },
          { code: 'juice', sortOrder: 1, numericValue: null, numericUnit: null },
        ]),
      },
    };
    const service = new ThresholdsService(prisma as never, 60 * 60 * 1000);

    const first = await service.getActiveValueSetMembers('fluid_type');
    // A careless caller sorting/filtering "in place" — exactly S5's failure
    // mode if getActiveValueSetMembers ever returned the cached array by
    // reference instead of a copy.
    (first as ActiveValueSetMember[]).reverse();

    const second = await service.getActiveValueSetMembers('fluid_type');

    expect(second).toEqual([
      { code: 'water', sortOrder: 0, numericValue: null, numericUnit: null },
      { code: 'juice', sortOrder: 1, numericValue: null, numericUnit: null },
    ]);
    expect(second).not.toBe(first);
  });

  it('invalidate() clears the value-set cache too', async () => {
    const prisma = {
      validationThreshold: { findMany: vi.fn() },
      valueSet: { findUnique: vi.fn().mockResolvedValue({ id: 'value-set-1', key: 'fluid_type' }) },
      valueSetMember: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { code: 'water', sortOrder: 0, numericValue: null, numericUnit: null },
          ]),
      },
    };
    const service = new ThresholdsService(prisma as never, 60 * 60 * 1000);

    await service.getActiveValueSetMembers('fluid_type');
    service.invalidate();
    await service.getActiveValueSetMembers('fluid_type');

    expect(prisma.valueSetMember.findMany).toHaveBeenCalledTimes(2);
  });
});
