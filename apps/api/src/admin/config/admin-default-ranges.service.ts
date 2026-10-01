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

import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { AuditService } from '../../audit/audit.service';
import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

import {
  windowsOverlap,
  type AdminDefaultRangesResponse,
  type AdminOstomyType,
  type CreateDefaultRangeRequest,
  type DefaultRangeSnapshot,
  type UpdateDefaultRangeRequest,
} from './admin-default-range-wire';
import { toNumericValue } from './decimal';

/** What `audit_events.entity_type` carries for these rows. Greppable and stable. */
export const DEFAULT_RANGE_ENTITY_TYPE = 'clinical_default_range';

/** A completed write and the id of the audit row committed with it. See PR A and B. */
export interface DefaultRangeWrite {
  readonly range: DefaultRangeSnapshot;
  /** The `clinical_default_ranges.id`, which is what the audit row identifies. */
  readonly rangeId: string;
  readonly auditEventId: string;
  /** The row's `updated_at`, ISO 8601 — the concurrency token for the next write. */
  readonly updatedAt: string;
}

interface RangeRow {
  readonly ostomyType: AdminOstomyType;
  readonly rangeType: string;
  readonly minDaysPostOp: number | null;
  readonly maxDaysPostOp: number | null;
  readonly lowValue: { toNumber: () => number } | null;
  readonly highValue: { toNumber: () => number } | null;
  readonly unit: string;
  readonly windowDays: number | null;
}

/** One place, so the audit snapshot and the read projection cannot drift apart. */
function toSnapshot(row: RangeRow): DefaultRangeSnapshot {
  return {
    ostomyType: row.ostomyType,
    rangeType: row.rangeType,
    minDaysPostOp: row.minDaysPostOp,
    maxDaysPostOp: row.maxDaysPostOp,
    lowValue: toNumericValue(row.lowValue),
    highValue: toNumericValue(row.highValue),
    unit: row.unit,
    windowDays: row.windowDays,
  };
}

/**
 * Admin configuration writes for clinical default range tables (P3.S3 PR C, ADR-0008).
 *
 * The same shape PR A established and PR B copied — audit written with
 * `AuditService.record(context, tx)` inside the transaction, the write returning the
 * audit id `stageCommittedAuditEntry` demands, `reasonCode: 'admin_config_change'`, the
 * correlation id threaded, optimistic concurrency where a write is blind.
 *
 * Two things differ, and both are consequences of what this table is.
 *
 * **No cache to invalidate.** `ThresholdsService` caches thresholds and value-set
 * members and reads neither this table nor anything derived from it, so there is
 * nothing to clear. The other two services call `invalidate()` here; copying that call
 * would be cargo cult, and the absence is deliberate rather than an oversight. It
 * changes when §3.9's seeding arrives and starts reading these rows.
 *
 * **Overlap is the invariant.** See `admin-default-range-wire.ts` for why — the short
 * version is that two rows matching the same patient makes §3.9 seed from whichever
 * the query returned, silently.
 */
@Injectable()
export class AdminDefaultRangesService {
  // Explicit `@Inject()`, not implicit type-based injection — see `AuditService`'s
  // constructor comment for why the latter resolves to `undefined` under this
  // workspace's Vitest (esbuild) transform.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /**
   * Every default range, ordered so the windows for one rule read in sequence.
   *
   * A read, so no audit row (SRS §5.2), and it carries no patient identifier — these
   * are population-level defaults, which is the whole reason they can live on a
   * zero-PHI surface at all.
   */
  async listDefaultRanges(): Promise<AdminDefaultRangesResponse> {
    const rows = await this.prisma.clinicalDefaultRange.findMany({
      orderBy: [{ ostomyType: 'asc' }, { rangeType: 'asc' }, { minDaysPostOp: 'asc' }],
    });

    return {
      defaultRanges: rows.map((row) => ({
        ...toSnapshot(row),
        id: row.id,
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  }

  /**
   * Refuses a window that overlaps an existing row for the same ostomy type and range
   * type.
   *
   * Inside the caller's transaction, so the rows it reads are the rows the write will
   * land beside. That is necessary and **not sufficient**: at READ COMMITTED two
   * concurrent creates can each see no conflict and both commit, and unlike PR A's
   * duplicate code there is no unique index to catch it — the table has only an index
   * on `(ostomy_type, range_type)`, correctly, because many rows share that pair.
   *
   * The durable fix is a Postgres exclusion constraint over the day range, which is a
   * migration and a schema-owner decision rather than something to slip into an admin
   * surface. Until then this is a check that holds against sequential use and loses a
   * race, which is worth stating plainly rather than implying the invariant is
   * enforced.
   */
  private async assertNoOverlap(
    tx: Prisma.TransactionClient,
    candidate: {
      ostomyType: AdminOstomyType;
      rangeType: string;
      minDaysPostOp: number | null;
      maxDaysPostOp: number | null;
    },
  ): Promise<void> {
    // Only `create` calls this, and there is no `excludeId` parameter, because an
    // update cannot produce an overlap: the ostomy type, range type and both window
    // bounds are all immutable, so the only row whose window could move is one that
    // cannot. A first draft carried that parameter and nothing passed it — dead code
    // that would have read as though updates were checked when they need not be.
    const siblings = await tx.clinicalDefaultRange.findMany({
      where: { ostomyType: candidate.ostomyType, rangeType: candidate.rangeType },
    });

    if (siblings.some((sibling) => windowsOverlap(sibling, candidate))) {
      throw new ConflictException({ error: { code: 'DEFAULT_RANGE_WINDOW_OVERLAPS' } });
    }
  }

  async createDefaultRange(
    request: CreateDefaultRangeRequest,
    adminId: string,
    correlationId: string | undefined,
  ): Promise<DefaultRangeWrite> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertNoOverlap(tx, request);

      const created = await tx.clinicalDefaultRange.create({
        data: {
          ostomyType: request.ostomyType,
          rangeType: request.rangeType,
          minDaysPostOp: request.minDaysPostOp,
          maxDaysPostOp: request.maxDaysPostOp,
          lowValue: request.lowValue,
          highValue: request.highValue,
          unit: request.unit,
          windowDays: request.windowDays,
        },
      });

      const after = toSnapshot(created);
      const auditEvent = await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'CREATE',
          entityType: DEFAULT_RANGE_ENTITY_TYPE,
          entityId: created.id,
          reasonCode: 'admin_config_change',
          ...(correlationId !== undefined ? { correlationId } : {}),
          // No `beforeValue`: nothing existed. Absent rather than an empty object, so a
          // reader can tell a creation from a before state that was not captured.
          afterValue: after,
        },
        tx,
      );

      return {
        range: after,
        rangeId: created.id,
        auditEventId: auditEvent.id,
        updatedAt: created.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Changes a rule's parameters. Addressed by `id`, not by its type pair, because the
   * pair is not unique — that is the whole shape of this table.
   *
   * The identity fields are absent from the `data` object and must stay absent: editing
   * one turns the row into a different default rather than correcting this one. Read off
   * `request` by name and never spread, for the reason PR B records — a request built by
   * spreading would not be caught by excess-property checking.
   */
  async updateDefaultRange(
    id: string,
    request: UpdateDefaultRangeRequest,
    adminId: string,
    correlationId: string | undefined,
    expectedUpdatedAt?: Date,
  ): Promise<DefaultRangeWrite> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.clinicalDefaultRange.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException({ error: { code: 'DEFAULT_RANGE_NOT_FOUND' } });
      }

      const before = toSnapshot(existing);
      const token = expectedUpdatedAt ?? existing.updatedAt;

      let updated;
      try {
        updated = await tx.clinicalDefaultRange.update({
          where: { id: existing.id, updatedAt: token },
          data: {
            lowValue: request.lowValue,
            highValue: request.highValue,
            windowDays: request.windowDays,
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          // The row moved between the read and the write. Reported, so the caller
          // re-reads rather than overwriting a change it never saw — and so the audit
          // chain does not acquire a hole where two rows both record the same before
          // value (PR B's review).
          throw new ConflictException({ error: { code: 'DEFAULT_RANGE_MODIFIED_CONCURRENTLY' } });
        }
        throw error;
      }

      const after = toSnapshot(updated);
      const auditEvent = await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'UPDATE',
          entityType: DEFAULT_RANGE_ENTITY_TYPE,
          entityId: existing.id,
          reasonCode: 'admin_config_change',
          ...(correlationId !== undefined ? { correlationId } : {}),
          beforeValue: before,
          afterValue: after,
        },
        tx,
      );

      return {
        range: after,
        rangeId: existing.id,
        auditEventId: auditEvent.id,
        updatedAt: updated.updatedAt.toISOString(),
      };
    });
  }

  /**
   * Removes a default range.
   *
   * A real delete, which neither of the other two surfaces has, and the asymmetry is
   * deliberate. A value-set member is referenced by stored clinical records, so deleting
   * one makes a patient's history unreadable; a threshold is read by code that throws
   * without it. A default range is referenced by nothing — `effective_ranges` carries
   * its own bounds with `provenance: CLINICAL_DEFAULT`, which is a copy and not a
   * pointer, and no foreign key exists from it to this table. So deleting one cannot
   * alter a range any patient already has.
   *
   * It also has to exist: the overlap rule makes a wrong window something that must be
   * removable, and the identity fields are immutable, so delete-and-create is the
   * correction path.
   *
   * The audit row carries `beforeValue` and no `afterValue` — the inverse of a create,
   * and the only record of what the row said.
   */
  async deleteDefaultRange(
    id: string,
    adminId: string,
    correlationId: string | undefined,
  ): Promise<{ range: DefaultRangeSnapshot; rangeId: string; auditEventId: string }> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.clinicalDefaultRange.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException({ error: { code: 'DEFAULT_RANGE_NOT_FOUND' } });
      }

      const before = toSnapshot(existing);
      await tx.clinicalDefaultRange.delete({ where: { id: existing.id } });

      const auditEvent = await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'DELETE',
          entityType: DEFAULT_RANGE_ENTITY_TYPE,
          entityId: existing.id,
          reasonCode: 'admin_config_change',
          ...(correlationId !== undefined ? { correlationId } : {}),
          beforeValue: before,
        },
        tx,
      );

      return { range: before, rangeId: existing.id, auditEventId: auditEvent.id };
    });
  }
}
