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

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { Prisma } from '../../generated/prisma/client';

import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ThresholdsService } from '../../thresholds/thresholds.service';

import { toRequiredNumber } from './decimal';
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
  /**
   * The row's new `updated_at`, ISO 8601.
   *
   * Returned because it is the concurrency token for the NEXT write — without it a
   * caller has to re-GET after every change to be able to make another one. It is
   * deliberately not part of `ThresholdSnapshot`, which is the audit shape: it changes
   * on every write by definition, so recording it as a before/after pair is noise in a
   * row that exists to show what substantively changed.
   */
  readonly updatedAt: string;
}

/** The Prisma row shape both paths project from. */
interface ThresholdRow {
  readonly thresholdKey: string;
  readonly tier: ThresholdTier;
  readonly value: { toNumber: () => number };
  readonly unit: string | null;
  readonly patientAdjustable: boolean;
  readonly description: string | null;
  readonly minSettableValue: { toNumber: () => number };
  readonly maxSettableValue: { toNumber: () => number };
}

/**
 * `value` must lie within the range this key allows (#93).
 *
 * The shape rules — positive, fits `DECIMAL(12,4)` — cannot catch a value that
 * is well-formed and still disables the system. `sync_clock_skew_allowance_seconds
 * = 1` Tier-1 blocks queued entries from every slightly-fast device, each
 * landing in a correction inbox describing a problem the patient cannot fix; a
 * 20 mL stoma-output warning fires on every entry, which is exactly how
 * patients learn to dismiss warnings.
 *
 * Three things about where and how this runs:
 *
 * It reads the bounds off the row this transaction has ALREADY read, so there
 * is no second query and no way for the bounds to be read from a different row
 * version than the value being replaced.
 *
 * It runs **before** the write, which is not merely tidier: the same invariant
 * is a CHECK constraint, so skipping this would turn an out-of-range edit into a
 * Prisma error and therefore an opaque 500 naming no field — precisely the
 * defect PR A fixed for the representable-range bounds, and one that
 * `docs/sync-contract.md` §9 would have a client retry forever if it were on a
 * sync path. The constraint is the backstop; this is the interface.
 *
 * It names the field and a rule code and **never the offending value or the
 * bounds**. The bounds are not secret — `GET` returns them — but this response
 * is built by the same rule as every other 400 on these surfaces, and a caller
 * that wants them has already been given them.
 */
function assertWithinSettableRange(value: number, bounds: ThresholdSnapshot): void {
  if (value >= bounds.minSettableValue && value <= bounds.maxSettableValue) return;
  throw new BadRequestException({
    error: {
      code: 'INVALID_THRESHOLD_UPDATE',
      fields: [{ field: 'value', rule: 'outside_settable_range' }],
    },
  });
}

/** One place, so the audit snapshot and the read projection cannot drift apart. */
function toSnapshot(row: ThresholdRow): ThresholdSnapshot {
  return {
    thresholdKey: row.thresholdKey,
    tier: row.tier,
    // `toRequiredNumber`, not `toNumericValue(...) as number`: the column is NOT NULL,
    // and a cast is what made the old version compile rather than the declaration —
    // so making the row type nullable later would keep compiling while `null` flowed
    // into the audit JSON and into a response the schema declares as `z.number()`.
    value: toRequiredNumber(row.value),
    unit: row.unit,
    patientAdjustable: row.patientAdjustable,
    description: row.description,
    minSettableValue: toRequiredNumber(row.minSettableValue),
    maxSettableValue: toRequiredNumber(row.maxSettableValue),
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
    /**
     * The `updatedAt` the caller last read, when it read one.
     *
     * **No HTTP caller can supply this, and this comment used to imply one
     * could.** It said the parameter was optional "so the maintenance script
     * (PR D) and a first-time console can write without a prior GET" — and PR D
     * then showed that wrong in both halves: the script *does* GET first (it has
     * to, because `updateThresholdSchema` requires `description` and a
     * value-only change must carry the label forward), and it still cannot pass
     * a token, because that schema is `.strict()` over `{value, description}`
     * and the controller never reads one. So every write through the API today
     * takes the `?? existing.updatedAt` branch below.
     *
     * The parameter is kept because the branch it feeds is correct and the
     * console will want it, but adding it to the surface needs a wire change —
     * tracked rather than implied here. Until then the honest statement is:
     * **the HTTP surface is last-write-wins on the value**, while the audit
     * chain stays sound, because the conditional update runs against the row as
     * read inside this transaction, so two concurrent writers cannot both record
     * the same before-value — the loser gets a 409.
     */
    expectedUpdatedAt?: Date,
  ): Promise<ThresholdWrite> {
    const write = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.validationThreshold.findUnique({ where: { thresholdKey } });
      if (!existing) {
        throw new NotFoundException({ error: { code: 'THRESHOLD_NOT_FOUND' } });
      }

      const before = toSnapshot(existing);
      assertWithinSettableRange(request.value, before);

      /**
       * Conditional on the row not having moved since it was read, which it was not.
       *
       * `findUnique` then `update({ where: { id } })` at READ COMMITTED loses a
       * concurrent write: both transactions read 2000, the first commits 1500, the
       * second's predicate still matches on the primary key, and it writes 1200. The
       * value is merely last-write-wins — but the AUDIT CHAIN is worse than that, and
       * it is the thing this entity cannot afford to get wrong. The log then holds
       * `2000 -> 1500` and `2000 -> 1200`, so nothing records that 1500 ever governed,
       * and a reader reconstructing which bound was in force at a given moment gets a
       * wrong answer. This service's own comment calls the before value "the only
       * record of what the rule used to be"; a hole in that chain is not recoverable
       * from anywhere else, because nothing on a stored observation says which bound
       * it was checked against.
       *
       * PR A's conditional `updateMany` does not transfer: a retire has a target state
       * to build a predicate from and a blind value write has none. So the predicate is
       * the row version — `updatedAt`, from the caller when it supplied one and
       * otherwise from this transaction's own read.
       *
       * Honest limit: `updated_at` is `TIMESTAMPTZ(3)` and Prisma sets it client-side,
       * so two writes landing in the same millisecond defeat the token. The row lock
       * makes that window very small rather than absent.
       */
      const token = expectedUpdatedAt ?? existing.updatedAt;
      let updated;
      try {
        updated = await tx.validationThreshold.update({
          where: { id: existing.id, updatedAt: token },
          data: {
            value: request.value,
            // `null` clears the label; a string replaces it. Always present, because
            // the body is the complete state of the mutable pair — see the wire
            // module for why "absent means unchanged" was withdrawn.
            description: request.description,
            // `tier`, `thresholdKey`, `unit` and `patientAdjustable` are absent from
            // this object and must stay absent. See the wire module for why each one is
            // immutable; the shortest of those reasons is that a warning must never
            // become a block.
            //
            // Note these are read off `request` BY NAME and never spread into `data`.
            // That is load-bearing and invisible: a request object built by spreading
            // would not be caught by excess-property checking (the hazard CLAUDE.md
            // records for the sync constructors), and naming the fields means even a
            // polluted one cannot reach `tier`.
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          // The row moved between the read and the write. Reported rather than
          // silently applied, so the caller re-reads instead of overwriting a change
          // it never saw.
          throw new ConflictException({ error: { code: 'THRESHOLD_MODIFIED_CONCURRENTLY' } });
        }
        throw error;
      }

      const after = toSnapshot(updated);

      const auditEvent = await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'UPDATE',
          entityType: THRESHOLD_ENTITY_TYPE,
          entityId: existing.id,
          // Named by `AuditEvent.reasonCode`'s column comment and by `AuditContext`'s
          // own doc for P3.S3 specifically. Without it an admin configuration change
          // lands with `reason_code = NULL` and cannot be told apart from any other
          // write path when querying the log.
          reasonCode: 'admin_config_change',
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

      return {
        threshold: after,
        thresholdId: existing.id,
        auditEventId: auditEvent.id,
        updatedAt: updated.updatedAt.toISOString(),
      };
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
