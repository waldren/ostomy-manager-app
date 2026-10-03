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

/** A withdrawal: the row as it was, plus when it was withdrawn (#98). */
export interface DefaultRangeWithdrawal extends DefaultRangeWrite {
  /** `deleted_at`, ISO 8601. Non-null by construction — this is the tombstone. */
  readonly deletedAt: string;
}

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
      // Live rows only. §3.9's seeding will read this array, and a tombstone
      // reaching it would seed a range an admin had withdrawn.
      where: { deletedAt: null },
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

    // Every known type, ordered, not only those with rows: the table starts
    // empty and a console still has to know what it may create.
    const limits = await this.prisma.clinicalDefaultRangeLimits.findMany({
      orderBy: { rangeType: 'asc' },
    });

    /**
     * Withdrawn rows, newest first, so a restore is discoverable without the
     * audit log — which #98 names as the gap: "recovering a row means a human
     * reading JSON out of `audit_events` and retyping it".
     */
    const withdrawn = await this.prisma.clinicalDefaultRange.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
    });

    return {
      defaultRanges: rows.map((row) => ({
        ...toSnapshot(row),
        id: row.id,
        updatedAt: row.updatedAt.toISOString(),
      })),
      deletedRanges: withdrawn.map((row) => ({
        ...toSnapshot(row),
        id: row.id,
        updatedAt: row.updatedAt.toISOString(),
        // Non-null by the query's own filter; the schema requires it, so the
        // assertion is where the two meet rather than a convenience.
        deletedAt: (row.deletedAt as Date).toISOString(),
      })),
      rangeTypeLimits: limits.map((row) => ({
        rangeType: row.rangeType,
        minValue: row.minValue.toNumber(),
        maxValue: row.maxValue.toNumber(),
        unit: row.unit,
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

    // `create` and `restore` call this. There is still no `excludeId` parameter,
    // because neither caller has a row among the siblings: every identity field —
    // the ostomy type, the range type, both window bounds and `windowDays` — is
    // immutable, so no live row's window can move, and a restoring row is a
    // tombstone, which the filter below excludes. (A first draft carried that
    // parameter and nothing passed it; `update` still does not call this at all.)
    const siblings = await tx.clinicalDefaultRange.findMany({
      // Live rows only, matching #98's partial exclusion constraint. Without the
      // filter this check would be STRICTER than the database and would refuse a
      // replacement for a withdrawn row — blocking the delete-and-create
      // correction path that the window's immutability makes necessary.
      where: {
        ostomyType: candidate.ostomyType,
        rangeType: candidate.rangeType,
        deletedAt: null,
      },
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
    /**
     * The unit rule, now read from one place instead of compared across rows.
     *
     * Reported as a 400 field error rather than the 409 it was under #97: a unit
     * is now a fixed property of the type, so a wrong one is a malformed body
     * rather than a conflict with other rows' state. No console exists yet, so
     * this is the cheapest moment to reclassify it.
     *
     * This used to be `siblings.some((sibling) => sibling.unit !== candidate.unit)`
     * — correct, and the kind of invariant that only holds while every writer
     * goes through here. #97 made the other four rules database guarantees and
     * could not make this one, because it is a cross-row invariant an exclusion
     * constraint cannot partition; #102's limits table is the home it named.
     *
     * Comparing against the limits row is strictly stronger: the cross-row form
     * agreed with whatever the FIRST row of a type happened to say, so a type
     * whose rows were all in the wrong unit was self-consistent and accepted.
     */
    const limits = await this.limitsFor(tx, candidate.rangeType);
    if (candidate.unit !== limits.unit) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_DEFAULT_RANGE',
          fields: [{ field: 'unit', rule: 'wrong_unit_for_type' }],
        },
      });
    }
  }

  /**
   * The limits row for a range type, which the foreign key guarantees exists.
   *
   * Throws a 400 rather than a 500 if it does not, because the one way to reach
   * that is a `range_type` the FK would have refused — and this read happens
   * before the insert, so the FK has not fired yet.
   */
  private async limitsFor(
    tx: Prisma.TransactionClient,
    rangeType: string,
  ): Promise<{ minValue: number; maxValue: number; unit: string }> {
    const row = await tx.clinicalDefaultRangeLimits.findUnique({ where: { rangeType } });
    if (!row) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_DEFAULT_RANGE',
          fields: [{ field: 'rangeType', rule: 'unknown_range_type' }],
        },
      });
    }
    return {
      minValue: row.minValue.toNumber(),
      maxValue: row.maxValue.toNumber(),
      unit: row.unit,
    };
  }

  /**
   * The shape a safety-class row must have, on create and on update.
   *
   * ## Why this exists, and what both reviews found
   *
   * #98's delete guard rested on "DELETE is the only operation in the system
   * that can switch off a safety prompt". That was false. `PUT { lowValue:
   * 0.0001, highValue: null }` silences the prompt just as completely and
   * answers 200 with an audit row, leaving a row that still LOOKS configured in
   * `GET` — arguably worse than the delete, which at least leaves a visibly
   * absent row. `checkBounds` refuses only BOTH bounds being null, and
   * `assertWithinTypeLimits` skips nulls, so nothing examined it.
   *
   * The ceiling in the limits table did not help either: 300 bpm was chosen
   * because no reading can exceed it, which makes a threshold OF 300 one no
   * reading can exceed. A typo guard, not a silencing guard.
   *
   * ## The three rules, and why each is decidable without a clinician
   *
   * **A ceiling is required.** SRS §3.13 defines the red flag as "a reading
   * beyond a configured red-flag threshold" and its AC as a reading that
   * "exceeds" it — the bound is directional, so a safety row without a
   * `highValue` is not a configured threshold at all.
   *
   * **A floor is refused**, for the same reason: a lower bound would be a
   * different clinical claim than the spec makes, and a two-sided safety row
   * invites a reader to think bradycardia is in scope.
   *
   * **No rolling window.** #97's exclusion constraint partitions on
   * `window_days`, so a second safety row with `windowDays: 7` over the same
   * days is accepted and `assertNoOverlap`'s own comment says §3.9 would seed
   * both — two red-flag bounds matching one patient, one of them silent.
   *
   * None of these is the clinical number. They are the shape the spec already
   * states, enforced instead of assumed.
   */
  private assertSafetyRowShape(bounds: {
    rangeType: string;
    lowValue: number | null;
    highValue: number | null;
    windowDays?: number | null;
  }): void {
    if (!isSafetyRangeType(bounds.rangeType)) return;

    const problems: { field: string; rule: string }[] = [];
    if (bounds.highValue === null) {
      problems.push({ field: 'highValue', rule: 'required_for_safety_type' });
    }
    if (bounds.lowValue !== null) {
      problems.push({ field: 'lowValue', rule: 'not_applicable_to_safety_type' });
    }
    if (bounds.windowDays !== undefined && bounds.windowDays !== null) {
      problems.push({ field: 'windowDays', rule: 'not_applicable_to_safety_type' });
    }

    if (problems.length > 0) {
      throw new BadRequestException({
        error: { code: 'INVALID_DEFAULT_RANGE', fields: problems },
      });
    }
  }

  /**
   * Both bounds within what this range type permits (#102).
   *
   * The shape rules — numeric, fits `DECIMAL(12,4)` — cannot catch a value that
   * is well-formed and still wrong for its type. The case that matters is the
   * one #94 moved into this table: once `heart_rate_red_flag_bpm` is seeded, a
   * high value silences a seek-care prompt with no symptom at all.
   *
   * **Application-only, unlike #93's and #97's checks, and the first version of
   * this comment claimed otherwise.** It said "the constraint is the backstop,
   * this is the interface — the same layering as #93 and #97". There is no
   * constraint: this migration adds a CHECK on the limits table and the foreign
   * key, and nothing compares a range's bounds against its limits row. So a
   * migration, `packages/seed` or a psql session can still write a 99,999 bpm
   * red-flag bound, exactly the gap #97 existed to close for the other four
   * rules. What #102 did make structural is that the limits DATA is
   * migration-owned (`SELECT` only), which is a different claim.
   *
   * It names the field and a rule code and never the value or the bounds, which
   * is why `GET` returns the limits: a caller that wants the numbers has already
   * been given them.
   */
  private assertWithinTypeLimits(
    bounds: { lowValue: number | null; highValue: number | null },
    limits: { minValue: number; maxValue: number },
  ): void {
    const offending = (['lowValue', 'highValue'] as const).filter((field) => {
      const value = bounds[field];
      return value !== null && (value < limits.minValue || value > limits.maxValue);
    });

    if (offending.length > 0) {
      throw new BadRequestException({
        error: {
          code: 'INVALID_DEFAULT_RANGE',
          fields: offending.map((field) => ({ field, rule: 'outside_type_limits' })),
        },
      });
    }
  }

  /**
   * Brings a withdrawn range back (#98).
   *
   * The half of #98 the delete guard did not address: "recovering a row means a
   * human reading JSON out of `audit_events` and retyping it. The audit log is
   * not readable through any API."
   *
   * ## The restore can legitimately fail, and that is the ordinary case
   *
   * #97's exclusion constraint is partial on `deleted_at`, so a tombstone does
   * not occupy its window — which is what lets an admin withdraw a row and
   * create a replacement, the correction path the window's immutability makes
   * necessary. The consequence is that by the time someone restores, the window
   * may be filled by exactly that replacement. So this re-runs the overlap check
   * against live rows and answers `409 DEFAULT_RANGE_WINDOW_OVERLAPS` — the same
   * code a create would give, because it is the same rule and an admin should
   * not have to learn two.
   *
   * Audited as `CREATE`, with the restored row as `afterValue` and no before
   * state. From the table's point of view a range of that shape exists again
   * where none did, which is what a reader of the log needs to see; recording it
   * as an `UPDATE` clearing a column would describe the mechanism instead of the
   * event.
   */
  async restoreDefaultRange(
    id: string,
    adminId: string,
    correlationId: string | undefined,
  ): Promise<DefaultRangeWrite> {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.clinicalDefaultRange.findUnique({ where: { id } });
      if (!existing) {
        throw new NotFoundException({ error: { code: 'DEFAULT_RANGE_NOT_FOUND' } });
      }
      if (existing.deletedAt === null) {
        // Not an error worth inventing a new code for: the caller wanted a live
        // row of this id and there is one.
        throw new ConflictException({ error: { code: 'DEFAULT_RANGE_NOT_DELETED' } });
      }

      /**
       * Re-validated against the limits as they are NOW, not as they were when the
       * row was written.
       *
       * A restore is the one write on this surface whose content nobody is
       * looking at — the admin supplies an id and the bounds come back from the
       * tombstone. So a row withdrawn before #102 narrowed its type's limits
       * would come back outside them, and the limits table's whole purpose is
       * that no stored bound sits outside the clinically sensible interval for
       * its key. `assertNoOverlap` carries the unit half of the same argument,
       * comparing the row's unit against the type's declared one.
       *
       * This is also what the database cannot do for us here: #97's constraints
       * cover the window and the bound ordering, and #102's limits are
       * application-enforced by design (the FK buys referential integrity, not
       * the interval check).
       */
      await this.assertNoOverlap(tx, {
        ostomyType: existing.ostomyType,
        rangeType: existing.rangeType,
        minDaysPostOp: existing.minDaysPostOp,
        maxDaysPostOp: existing.maxDaysPostOp,
        windowDays: existing.windowDays,
        unit: existing.unit,
      });
      this.assertWithinTypeLimits(
        {
          lowValue: toNumericValue(existing.lowValue),
          highValue: toNumericValue(existing.highValue),
        },
        await this.limitsFor(tx, existing.rangeType),
      );

      let restored;
      try {
        restored = await tx.clinicalDefaultRange.update({
          where: { id: existing.id, updatedAt: existing.updatedAt },
          data: { deletedAt: null },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
          throw new ConflictException({ error: { code: 'DEFAULT_RANGE_MODIFIED_CONCURRENTLY' } });
        }
        if (isWindowOverlapViolation(error)) {
          // The database's own answer, for a row that filled the window without
          // taking the advisory lock.
          throw new ConflictException({ error: { code: 'DEFAULT_RANGE_WINDOW_OVERLAPS' } });
        }
        throw error;
      }

      const after = toSnapshot(restored);
      const auditEvent = await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'CREATE',
          entityType: DEFAULT_RANGE_ENTITY_TYPE,
          entityId: restored.id,
          reasonCode: 'admin_config_change',
          ...(correlationId !== undefined ? { correlationId } : {}),
          afterValue: after,
        },
        tx,
      );

      return {
        range: after,
        rangeId: restored.id,
        auditEventId: auditEvent.id,
        // The new concurrency token, same as every other write on this surface:
        // without it a caller must re-GET before it can make the next change.
        updatedAt: restored.updatedAt.toISOString(),
      };
    });
  }

  async createDefaultRange(
    request: CreateDefaultRangeRequest,
    adminId: string,
    correlationId: string | undefined,
  ): Promise<DefaultRangeWrite> {
    return this.prisma.$transaction(async (tx) => {
      /**
       * A safety row cannot be CREATED here either, and #98's own argument is
       * what requires that.
       *
       * If removing one is too dangerous for this surface, so is creating one
       * wrong — and the wrong ways are worse than they look. The day window is
       * immutable and the delete is refused, so a safety row created with a
       * window covering nobody (`{ minDaysPostOp: 10000 }` is accepted:
       * `MAX_DAYS_POST_OP` is 11,000 and `checkWindow` only orders the ends)
       * is **permanently unrecoverable through the API** — the correctly
       * windowed replacement is refused by `assertNoOverlap` and by #97's
       * exclusion constraint. One mistyped create bricks the red flag for that
       * ostomy type. The review found that regression in #98 itself, and the
       * test fixtures demonstrate the mechanism: they hand-partition the day
       * window space (40-70, 80-110, 200-260) precisely because safety rows
       * cannot be cleaned up.
       *
       * So the rows are seeded by migration — both ostomy types, day 0 onward,
       * no rolling window — and `PUT` is the only mutation left. SRS §3.9 calls
       * this "a fixed clinical safety bound managed in Section 3.11", and
       * `validation_thresholds` is the precedent for configuration every
       * environment needs arriving by migration.
       */
      if (isSafetyRangeType(request.rangeType)) {
        throw new ConflictException({ error: { code: 'SAFETY_RANGE_NOT_CREATABLE' } });
      }

      await this.assertNoOverlap(tx, request);
      this.assertWithinTypeLimits(request, await this.limitsFor(tx, request.rangeType));

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

      /**
       * The update is where a bound is actually changed, so it is the path that
       * matters most for #102 — a create with a sane bound followed by a `PUT`
       * to a silencing one would otherwise walk straight past the check.
       */
      if (existing.deletedAt !== null) {
        // A withdrawn row is history. Editing one would produce a tombstone
        // whose snapshot no longer matches what was withdrawn, and a restore
        // would then bring back something nobody deleted.
        throw new ConflictException({ error: { code: 'DEFAULT_RANGE_ALREADY_DELETED' } });
      }

      this.assertSafetyRowShape({ ...request, rangeType: existing.rangeType });
      this.assertWithinTypeLimits(request, await this.limitsFor(tx, existing.rangeType));

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
   * Withdraws a default range.
   *
   * ## It used to remove the row, and the old argument still holds as far as it went
   *
   * A real delete, which neither of the other two surfaces had, and the asymmetry was
   * deliberate. A value-set member is referenced by stored clinical records, so deleting
   * one makes a patient's history unreadable; a threshold is read by code that throws
   * without it. A default range is referenced by nothing — `effective_ranges` carries
   * its own bounds with `provenance: CLINICAL_DEFAULT`, which is a copy and not a
   * pointer, and no foreign key exists from it to this table. So deleting one cannot
   * alter a range any patient already has.
   *
   * Every word of that is still true. It is an argument about **safety**, and #98 was
   * about **recoverability**, which it never addressed: the row's only surviving copy
   * was `beforeValue` in an audit row no API exposes. So the row is now tombstoned,
   * `GET` publishes it under `deletedRanges`, and `restoreDefaultRange` brings it back.
   *
   * The delete still has to exist, for the reason it always did: the overlap rule makes
   * a wrong window something that must be removable, the identity fields are immutable,
   * and so delete-and-create is the correction path. #97's constraint is partial on
   * `deleted_at` precisely so a tombstone does not keep occupying that window.
   *
   * The audit action stays `DELETE`, with `beforeValue` and no `afterValue`. Recording
   * it as an `UPDATE` setting a column would bury a withdrawal among ordinary bound
   * edits in the one record meant to make it findable.
   */
  async deleteDefaultRange(
    id: string,
    adminId: string,
    correlationId: string | undefined,
  ): Promise<DefaultRangeWithdrawal> {
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

      /**
       * Already withdrawn (#98): a conflict, not a second delete.
       *
       * 409 rather than 404 because the row exists and an admin can still act on
       * it — `restoreDefaultRange` is the operation they want. A 404 would
       * suggest it was gone for good, which is the opposite of what soft delete
       * provides. Letting it through would also write a second DELETE audit row
       * with an identical before value, implying a change that did not happen.
       */
      if (existing.deletedAt !== null) {
        throw new ConflictException({ error: { code: 'DEFAULT_RANGE_ALREADY_DELETED' } });
      }

      const before = toSnapshot(existing);

      /**
       * A tombstone write, conditional on the row not having moved since it was
       * snapshotted (#98 changed the statement; the predicate is kept verbatim).
       *
       * `findUnique` then the write are two statements with their own snapshots at
       * READ COMMITTED. If another admin's `PUT` commits between them, the write
       * lands on **v2** while `beforeValue` records **v1**. That used to be
       * unrecoverable, because the audit row was then the only surviving record;
       * now the row survives and could be read back, which makes the consequence
       * smaller but not the guard optional — a `beforeValue` describing a version
       * nobody withdrew is a false entry in the one log that is supposed to be
       * the record. `updateDefaultRange` guards the same shape; the delete did
       * not, which is the asymmetry a reviewer caught.
       *
       * The audit action stays `DELETE`, with `beforeValue` and no `afterValue`:
       * recording it as an `UPDATE` setting a column would bury a withdrawal among
       * ordinary bound edits.
       */
      let withdrawn;
      try {
        withdrawn = await tx.clinicalDefaultRange.update({
          where: { id: existing.id, updatedAt: existing.updatedAt },
          data: { deletedAt: new Date() },
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

      return {
        range: before,
        rangeId: existing.id,
        auditEventId: auditEvent.id,
        updatedAt: withdrawn.updatedAt.toISOString(),
        // Non-null: this statement is what set it.
        deletedAt: (withdrawn.deletedAt as Date).toISOString(),
      };
    });
  }
}
