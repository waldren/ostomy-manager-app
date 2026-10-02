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
  isSafetyRangeType,
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
/** Postgres' SQLSTATE for `exclusion_violation`. */
const EXCLUSION_VIOLATION = '23P01';

/**
 * Whether an error is #97's day-window exclusion constraint firing.
 *
 * ## The shape was discovered, not assumed
 *
 * A first version of this matched `P2002` and `P2010` and read the SQLSTATE
 * from `meta.code`. All three were wrong. What Prisma 7 with the pg driver
 * adapter actually reports, printed by the integration test that now asserts
 * it:
 *
 * ```
 * PrismaClientKnownRequestError
 *   code: 'P2039'
 *   meta.driverAdapterError.cause.code: '23P01'
 *   meta.driverAdapterError.cause.message:
 *     'conflicting key value violates exclusion constraint
 *      "clinical_default_ranges_window_no_overlap"'
 * ```
 *
 * Matching the serialised `meta` for the SQLSTATE and the constraint name
 * rather than walking that path, deliberately: `driverAdapterError` is a
 * driver-adapter detail whose nesting has changed across Prisma versions,
 * while the SQLSTATE and the constraint name are the two facts Postgres
 * guarantees. A path-walk would compile and silently stop matching on an
 * upgrade, turning a 409 back into a 500 with no test failing — which is the
 * failure this function exists to prevent.
 *
 * ## Why it is needed at all
 *
 * `assertNoOverlap` takes an advisory lock and reads the siblings, so two
 * concurrent creates through this service cannot produce an overlap. What it
 * cannot see is a row inserted by something that never takes the lock — a
 * migration, `packages/seed`, a psql session. Before #97 such a row simply
 * created an overlapping pair; now the constraint refuses it, and without this
 * the refusal would reach the admin as an opaque 500 naming no rule. P3.S3 PR A
 * fixed that shape for the representable-range bounds and #93 fixed it again
 * for the settable range; this is the third instance, which is why it is
 * handled here rather than left to be noticed.
 */
function isWindowOverlapViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;

  const reported = JSON.stringify(error.meta ?? {});
  return (
    reported.includes(EXCLUSION_VIOLATION) &&
    reported.includes('clinical_default_ranges_window_no_overlap')
  );
}

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
      // `nulls: 'first'`, because Postgres `ASC` is NULLS LAST and a null
      // `minDaysPostOp` means "from surgery" — day 0, the FIRST window. It was sorting
      // after day 3650, which contradicted this route's own claim that the windows read
      // in sequence. That ordering also matters for the overlap race: an accidentally
      // overlapping pair is what an admin is most likely to spot by eye, and the old
      // ordering could separate the two rows.
      orderBy: [
        { ostomyType: 'asc' },
        { rangeType: 'asc' },
        { minDaysPostOp: { sort: 'asc', nulls: 'first' } },
      ],
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
      windowDays: number | null;
      unit: string;
    },
  ): Promise<void> {
    /**
     * Serialised per type pair before the read, which closes the race the first
     * version only documented.
     *
     * Being inside the transaction buys atomicity of the refusal — nothing is written
     * when it throws — and **no read-set stability at all**: at READ COMMITTED the
     * `findMany` and the `create` are separate statements with separate snapshots even
     * when nothing else is running. The first version of this comment said the
     * transaction meant "the rows it reads are the rows the write will land beside"
     * and then admitted otherwise in the next sentence.
     *
     * `SELECT … FOR UPDATE` cannot fix it, and is worth recording as rejected so
     * nobody tries: row locks cannot lock rows that do not exist, and the common case
     * is two creates into a type pair with no siblings. This is a phantom, not a lost
     * update. `SERIALIZABLE` would work via predicate locks but introduces a 40001 /
     * `P2034` retry class this repo has no precedent for handling.
     *
     * A transaction-scoped advisory lock is the proportionate fix and the one this
     * repo already named for the analogous phantom — see
     * `design-specs/data-model/p1-s3-schema-coverage.md`'s note on the delta cursor.
     * It releases on commit or rollback, needs no isolation change and no new grant,
     * and a hash collision only over-serialises.
     *
     * Not taken in `delete`: a delete only frees a window, so a create racing it may
     * 409 spuriously, which costs a re-read rather than a corrupt row.
     */
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`${candidate.ostomyType}:${candidate.rangeType}`}))`;

    // Only `create` calls this, and there is no `excludeId` parameter, because an
    // update cannot produce an overlap: every identity field — the ostomy type, the
    // range type, both window bounds and `windowDays` — is immutable, so the only row
    // whose window could move is one that cannot. A first draft carried that parameter
    // and nothing passed it.
    const siblings = await tx.clinicalDefaultRange.findMany({
      where: { ostomyType: candidate.ostomyType, rangeType: candidate.rangeType },
    });

    /**
     * Scoped by `windowDays` as well as the type pair.
     *
     * Without it, a 5%-over-7-days rule and a 10%-over-30-days rule for the same
     * ostomy type and the same post-operative window collide — and SRS §3.12 has the
     * admin managing "rolling-window definitions", plural, so that pair is ordinary
     * configuration rather than a mistake. Two rows of DIFFERENT shape matching one
     * patient is not ambiguity: §3.9 seeds both as separate ranges.
     */
    const sameShape = siblings.filter((sibling) => sibling.windowDays === candidate.windowDays);
    if (sameShape.some((sibling) => windowsOverlap(sibling, candidate))) {
      throw new ConflictException({ error: { code: 'DEFAULT_RANGE_WINDOW_OVERLAPS' } });
    }

    /**
     * Every row sharing a `rangeType` must agree on the unit.
     *
     * The wire module rests `unit`'s immutability on "the rangeType already names it",
     * and across rows nothing enforced that: days 0–30 in `mL` beside days 31–60 in
     * `oz` were both accepted. Per row that is self-describing and harmless; the
     * hazard is that §3.9's consumer is precisely the reader the comment licenses to
     * treat `rangeType` as naming the unit. Free to check, because the siblings are
     * already here.
     */
    if (siblings.some((sibling) => sibling.unit !== candidate.unit)) {
      throw new ConflictException({ error: { code: 'DEFAULT_RANGE_UNIT_CONFLICTS' } });
    }
  }

  async createDefaultRange(
    request: CreateDefaultRangeRequest,
    adminId: string,
    correlationId: string | undefined,
  ): Promise<DefaultRangeWrite> {
    return this.prisma.$transaction(async (tx) => {
      await this.assertNoOverlap(tx, request);

      /**
       * The constraint is the backstop and `assertNoOverlap` is the interface,
       * so a violation reaching here is translated rather than allowed to
       * become a 500. It happens for one input only: a conflicting row that
       * was inserted without taking the advisory lock, i.e. by a migration,
       * the seeder, or a psql session. See `isWindowOverlapViolation`.
       */
      let created;
      try {
        created = await tx.clinicalDefaultRange.create({
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
      } catch (error) {
        if (isWindowOverlapViolation(error)) {
          // The same code the service-side check uses, because it is the same
          // rule — an admin should not be able to tell which layer caught it.
          throw new ConflictException({ error: { code: 'DEFAULT_RANGE_WINDOW_OVERLAPS' } });
        }
        throw error;
      }

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
            // `windowDays` is absent and must stay absent: it is part of the row
            // identity, so two rules for one `rangeType` are told apart by it. See the
            // wire module for why it moved out of the mutable set.
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

      /**
       * A safety-class row cannot be deleted through this surface (#98).
       *
       * Checked after the existence lookup so a missing id still answers 404 —
       * reporting "not deletable" for a row that does not exist would tell a
       * caller something false, and would also leak that *some* row with that
       * id was protected.
       *
       * `409` rather than `403`: nothing about the admin's authorisation is
       * wrong, and this is not a permission that a different admin would have.
       * The request conflicts with the state of the resource — the row is of a
       * kind that is not removable — which is what a conflict means here and
       * what every other refusal on this surface already uses.
       */
      if (isSafetyRangeType(existing.rangeType)) {
        throw new ConflictException({ error: { code: 'SAFETY_RANGE_NOT_DELETABLE' } });
      }

      const before = toSnapshot(existing);

      /**
       * Conditional on the row not having moved since it was snapshotted.
       *
       * `findUnique` then `delete({ where: { id } })` are two statements with their own
       * snapshots at READ COMMITTED. If another admin's `PUT` commits between them,
       * Prisma's delete re-reads at the newer snapshot and removes **v2** while
       * `beforeValue` records **v1** — and this is the one path where that is
       * unrecoverable, because after the delete the audit row is the only surviving
       * record of what the row said. `updateDefaultRange` already guards this shape;
       * the delete did not, which is the asymmetry a reviewer caught.
       */
      try {
        await tx.clinicalDefaultRange.delete({
          where: { id: existing.id, updatedAt: existing.updatedAt },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          throw new ConflictException({ error: { code: 'DEFAULT_RANGE_MODIFIED_CONCURRENTLY' } });
        }
        throw error;
      }

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
