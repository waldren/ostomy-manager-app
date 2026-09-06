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

import { Inject, Injectable, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { VolumetricValidationThresholds } from '@ostomy/core/validation';

/**
 * The `validation_thresholds.threshold_key` values this service reads for
 * `getVolumetricThresholds()`. Matching the examples named in
 * `schema.prisma`'s `ValidationThreshold` doc comment and
 * `design-specs/data-model/p1-s3-schema-coverage.md` — these are not
 * invented ad hoc, but they are also not yet seeded by any migration or
 * seed generator (P2.S4 owns seeding; P1.S3 explicitly left this table
 * empty). Callers in development/test insert rows for these keys directly;
 * see `thresholds.service.spec.ts`/`thresholds.integration.spec.ts`.
 */
export const THRESHOLD_KEY = {
  /** Canonical mL. SRS AC 2.1 AC2's ">2,000 mL" rule is one admin-configured value of this, not a special case. */
  STOMA_OUTPUT_SOFT_WARNING_ML: 'stoma_output_single_entry_warning_ml',
  /** Seconds — converted to milliseconds for `VolumetricValidationThresholds.maxClockSkewMs`, which packages/core defines in ms. */
  SYNC_CLOCK_SKEW_ALLOWANCE_SECONDS: 'sync_clock_skew_allowance_seconds',
} as const;

const REQUIRED_VOLUMETRIC_THRESHOLD_KEYS = [
  THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML,
  THRESHOLD_KEY.SYNC_CLOCK_SKEW_ALLOWANCE_SECONDS,
] as const;

/** A retired-never-deleted value set member, trimmed to what a caller needs to render a picker (CLAUDE.md "Value-set members are retired, never deleted"). */
export interface ActiveValueSetMember {
  readonly code: string;
  readonly sortOrder: number;
}

interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

/** Five minutes — short enough that an admin-managed change (P3.S3) is felt promptly without a restart, long enough that a hot validation path is not issuing a query per call. Overridable per-instance for tests via the constructor's second argument. */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

export const THRESHOLDS_CACHE_TTL_MS = Symbol('THRESHOLDS_CACHE_TTL_MS');

/**
 * Reads validation thresholds and value sets from the database (SRS §3.11;
 * CLAUDE.md "Numeric thresholds are admin-managed configuration, not
 * constants in code") and produces the exact shape `packages/core/validation`
 * already defines (`VolumetricValidationThresholds`) — never a parallel
 * shape, per this sprint's own instruction, so `evaluateTier1`/`evaluateTier2`
 * (P2.S1a's server-side re-enforcement) can take this service's output
 * directly as their `thresholds` argument.
 *
 * Cached in-memory per key with a short TTL, plus an explicit `invalidate()`
 * an admin-config write path (P3.S3, not built yet) can call so a threshold
 * change is felt immediately rather than waiting out the TTL — see
 * `thresholds.service.spec.ts`/`thresholds.integration.spec.ts` for the
 * "changed row is picked up without a restart" proof (AC 13.2 AC2's
 * enabling requirement, per this sprint's own exit criteria).
 */
@Injectable()
export class ThresholdsService {
  private volumetricCache: CacheEntry<VolumetricValidationThresholds> | undefined;
  private readonly valueSetCache = new Map<string, CacheEntry<ActiveValueSetMember[]>>();
  private readonly cacheTtlMs: number;

  // Explicit `@Inject(PrismaService)` — see `AuditService`'s constructor
  // comment for why implicit type-based injection is not safe under this
  // workspace's Vitest (esbuild) transform.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(THRESHOLDS_CACHE_TTL_MS) cacheTtlMs?: number,
  ) {
    this.cacheTtlMs = cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Returns `packages/core/validation`'s `VolumetricValidationThresholds`,
   * populated from `validation_thresholds` rows. Throws if a required
   * threshold key has no row yet — a missing clinical threshold must fail
   * loudly (no validation should ever run against a silently-defaulted
   * bound), not fall back to an undocumented constant.
   */
  async getVolumetricThresholds(): Promise<VolumetricValidationThresholds> {
    const cached = this.readCache(this.volumetricCache);
    if (cached) return cached;

    const value = await this.loadVolumetricThresholds();
    this.volumetricCache = { value, expiresAt: Date.now() + this.cacheTtlMs };
    return value;
  }

  /**
   * Active (non-retired) members of an admin-managed value set (SRS §3.11),
   * ordered for display. Retired members are never returned here — CLAUDE.md
   * "Value-set members are retired, never deleted": retirement means "stop
   * offering this in a picker," which is exactly this method's contract; a
   * historical record referencing a retired code resolves it elsewhere
   * (whichever sprint renders history), not through this method.
   */
  async getActiveValueSetMembers(valueSetKey: string): Promise<ActiveValueSetMember[]> {
    const cached = this.readCache(this.valueSetCache.get(valueSetKey));
    if (cached) return cached;

    const value = await this.loadActiveValueSetMembers(valueSetKey);
    this.valueSetCache.set(valueSetKey, { value, expiresAt: Date.now() + this.cacheTtlMs });
    return value;
  }

  /**
   * Clears every cached value immediately. An admin-config write path
   * (P3.S3) calls this after a successful write so the next read reflects
   * the change without waiting out the TTL — see the class doc comment.
   */
  invalidate(): void {
    this.volumetricCache = undefined;
    this.valueSetCache.clear();
  }

  private readCache<T>(entry: CacheEntry<T> | undefined): T | undefined {
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value;
    }
    return undefined;
  }

  private async loadVolumetricThresholds(): Promise<VolumetricValidationThresholds> {
    const rows = await this.prisma.validationThreshold.findMany({
      where: { thresholdKey: { in: [...REQUIRED_VOLUMETRIC_THRESHOLD_KEYS] } },
    });
    const byKey = new Map(rows.map((row) => [row.thresholdKey, row]));

    const softWarning = byKey.get(THRESHOLD_KEY.STOMA_OUTPUT_SOFT_WARNING_ML);
    const clockSkewSeconds = byKey.get(THRESHOLD_KEY.SYNC_CLOCK_SKEW_ALLOWANCE_SECONDS);

    const missing = REQUIRED_VOLUMETRIC_THRESHOLD_KEYS.filter((key) => !byKey.has(key));
    if (missing.length > 0) {
      throw new Error(
        `ThresholdsService: missing required validation_thresholds row(s) for: ${missing.join(', ')}. ` +
          'A clinical threshold must be admin-configured, never silently defaulted in code.',
      );
    }

    return {
      softWarningMaxMl: softWarning!.value.toNumber(),
      maxClockSkewMs: clockSkewSeconds!.value.toNumber() * 1000,
    };
  }

  private async loadActiveValueSetMembers(valueSetKey: string): Promise<ActiveValueSetMember[]> {
    const valueSet = await this.prisma.valueSet.findUnique({ where: { key: valueSetKey } });
    if (!valueSet) {
      throw new Error(`ThresholdsService: no value set registered with key "${valueSetKey}".`);
    }

    const members = await this.prisma.valueSetMember.findMany({
      where: { valueSetId: valueSet.id, status: 'ACTIVE' },
      orderBy: { sortOrder: 'asc' },
    });

    return members.map((member) => ({ code: member.code, sortOrder: member.sortOrder }));
  }
}
