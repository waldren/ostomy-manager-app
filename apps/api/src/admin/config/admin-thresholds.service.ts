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

import { Inject, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ThresholdsService } from '../../thresholds/thresholds.service';

import { toNumericValue } from './admin-value-set-wire';
import type {
  AdminThresholdsResponse,
  ThresholdSnapshot,
  ThresholdTier,
  UpdateThresholdRequest,
} from './admin-threshold-wire';

/** What `audit_events.entity_type` carries for these rows. Greppable and stable. */
export const THRESHOLD_ENTITY_TYPE = 'validation_threshold';

/** A completed write and the id of the audit row committed with it. See PR A's equivalent. */
export interface ThresholdWrite {
  readonly threshold: ThresholdSnapshot;
  /** The `validation_thresholds.id`, which is what the audit row identifies. */
  readonly thresholdId: string;
  readonly auditEventId: string;
}

/** The Prisma row shape both paths project from. */
interface ThresholdRow {
  readonly thresholdKey: string;
  readonly tier: ThresholdTier;
  readonly value: { toNumber: () => number };
  readonly unit: string | null;
  readonly patientAdjustable: boolean;
  readonly description: string | null;
}

/** One place, so the audit snapshot and the read projection cannot drift apart. */
function toSnapshot(row: ThresholdRow): ThresholdSnapshot {
  return {
    thresholdKey: row.thresholdKey,
    tier: row.tier,
    // `value` is NOT NULL on this table, unlike a member's quantity — the helper is
    // shared for the Decimal conversion, and the non-null assertion is the column's.
    value: toNumericValue(row.value) as number,
    unit: row.unit,
    patientAdjustable: row.patientAdjustable,
    description: row.description,
  };
}

/**
 * Admin configuration writes for validation thresholds (P3.S3 PR B, ADR-0008).
 *
 * Deliberately the same shape as `AdminValueSetsService`, which PR A established as
 * the one to copy: the audit row is written with `AuditService.record(context, tx)`
 * inside the transaction, the returned write carries the audit id that
 * `stageCommittedAuditEntry` requires, and the read cache is invalidated after the
 * commit rather than inside it.
 *
 * What differs is what may change. `admin-threshold-wire.ts` sets that out at length;
 * the short version is that only `value` and `description` are editable, and `tier` is
 * not, because a warning must never become a block.
 */
@Injectable()
export class AdminThresholdsService {
  // Explicit `@Inject()`, not implicit type-based injection — see `AuditService`'s
  // constructor comment for why the latter resolves to `undefined` under this
  // workspace's Vitest (esbuild) transform.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ThresholdsService) private readonly thresholds: ThresholdsService,
  ) {}

  /**
   * Every threshold, including the ones no clinical rule reads yet.
   *
   * Unfiltered on purpose, the same argument as the value-set listing: an admin
   * managing configuration has to see what is there, and the alternative is the
   * database. It is also the only way to discover a key before changing it, since the
   * keys live in `THRESHOLD_KEY` in the server's source.
   *
   * A read, so no audit row (SRS §5.2), and it carries no patient identifier.
   */
  async listThresholds(): Promise<AdminThresholdsResponse> {
    const rows = await this.prisma.validationThreshold.findMany({
      orderBy: { thresholdKey: 'asc' },
    });

    return {
      thresholds: rows.map((row) => ({
        ...toSnapshot(row),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * Changes a threshold's value, and optionally its admin-tool label.
   *
   * No upsert. A key this table does not hold is a 404 rather than a creation, because
   * `THRESHOLD_KEY` is the closed set the server actually reads — a created row would
   * be configuration nothing consults, which is the shape of the P3.S2 defect where a
   * seeded value set reached no device. A typo in a key should fail loudly.
   */
  async updateThreshold(
    thresholdKey: string,
    request: UpdateThresholdRequest,
    adminId: string,
    correlationId: string | undefined,
  ): Promise<ThresholdWrite> {
    const write = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.validationThreshold.findUnique({ where: { thresholdKey } });
      if (!existing) {
        throw new NotFoundException({ error: { code: 'THRESHOLD_NOT_FOUND' } });
      }

      const before = toSnapshot(existing);

      const updated = await tx.validationThreshold.update({
        where: { id: existing.id },
        data: {
          value: request.value,
          // Spread-or-omit: `exactOptionalPropertyTypes` rejects an explicit
          // `undefined`, and the distinction is semantic here rather than cosmetic —
          // an absent `description` means "leave the label alone", where an empty
          // string means "clear it", and the audit row shows which one happened.
          ...(request.description !== undefined ? { description: request.description } : {}),
          // `tier`, `thresholdKey`, `unit` and `patientAdjustable` are absent from
          // this object and must stay absent. See the wire module for why each one is
          // immutable; the shortest of those reasons is that a warning must never
          // become a block.
        },
      });

      const after = toSnapshot(updated);

      const auditEvent = await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'UPDATE',
          entityType: THRESHOLD_ENTITY_TYPE,
          entityId: existing.id,
          ...(correlationId !== undefined ? { correlationId } : {}),
          // Both sides, always. A threshold change is the one admin action whose
          // effect is invisible in the data it governs — nothing about a later
          // observation records which bound it was checked against — so the before
          // value is the only record of what the rule used to be.
          beforeValue: before,
          afterValue: after,
        },
        tx,
      );

      return { threshold: after, thresholdId: existing.id, auditEventId: auditEvent.id };
    });

    // After the commit, never inside it: invalidating for a write that then rolls back
    // would serve a re-read of the old row as though it were news. Per-process, not
    // cluster-wide — see `ThresholdsService`'s class comment.
    //
    // This matters more here than it does for a value set. AC 13.2 AC2 expects an
    // admin change to govern "from the next successful fetch, with no application
    // release", and `GET /api/v1/thresholds` is what a client fetches; without this,
    // the change would sit invisible behind the TTL on the very path the acceptance
    // criterion names.
    this.thresholds.invalidate();
    return write;
  }
}
