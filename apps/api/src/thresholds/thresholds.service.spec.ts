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

import { THRESHOLD_KEY, ThresholdsService } from './thresholds.service';

/** A minimal stand-in for a Prisma `Decimal` — only `.toNumber()` is ever called on it by this service. */
function decimal(value: number) {
  return { toNumber: () => value };
}

function fakePrismaWithThresholds(
  overrides: {
    softWarningMaxMl?: number;
    clockSkewSeconds?: number;
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
        },
        {
          thresholdKey: THRESHOLD_KEY.SYNC_CLOCK_SKEW_ALLOWANCE_SECONDS,
          value: decimal(clockSkewSeconds),
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
      { thresholdKey: THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML, value: decimal(1800) },
      { thresholdKey: THRESHOLD_KEY.SYNC_CLOCK_SKEW_ALLOWANCE_SECONDS, value: decimal(300) },
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
          { code: 'water', sortOrder: 0 },
          { code: 'juice', sortOrder: 1 },
        ]),
      },
    };
    const service = new ThresholdsService(prisma as never, 60_000);

    const members = await service.getActiveValueSetMembers('fluid_type');

    expect(members).toEqual([
      { code: 'water', sortOrder: 0 },
      { code: 'juice', sortOrder: 1 },
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

  it('invalidate() clears the value-set cache too', async () => {
    const prisma = {
      validationThreshold: { findMany: vi.fn() },
      valueSet: { findUnique: vi.fn().mockResolvedValue({ id: 'value-set-1', key: 'fluid_type' }) },
      valueSetMember: {
        findMany: vi.fn().mockResolvedValue([{ code: 'water', sortOrder: 0 }]),
      },
    };
    const service = new ThresholdsService(prisma as never, 60 * 60 * 1000);

    await service.getActiveValueSetMembers('fluid_type');
    service.invalidate();
    await service.getActiveValueSetMembers('fluid_type');

    expect(prisma.valueSetMember.findMany).toHaveBeenCalledTimes(2);
  });
});
