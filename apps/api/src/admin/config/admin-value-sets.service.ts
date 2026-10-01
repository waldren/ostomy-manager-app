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

import { Prisma } from '../../generated/prisma/client';

import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ThresholdsService } from '../../thresholds/thresholds.service';

import {
  toNumericValue,
  type AddValueSetMemberRequest,
  type AdminValueSetsResponse,
  type ValueSetMemberSnapshot,
} from './admin-value-set-wire';

/** What `audit_events.entity_type` carries for these rows. Greppable and stable. */
export const VALUE_SET_MEMBER_ENTITY_TYPE = 'value_set_member';

/**
 * A completed write, and the id of the audit row committed with it.
 *
 * The id is returned rather than kept private because `stageCommittedAuditEntry`
 * requires it: it is what makes "this handler already wrote its audit row" a fact
 * the interceptor can check instead of a claim it has to trust (P2.S1a review).
 *
 * `auditEventId` is absent exactly when no row was written, which happens only on
 * the idempotent retire of an already-retired member — nothing changed, so there was
 * nothing to record.
 */
export interface ValueSetMemberWrite {
  readonly member: ValueSetMemberSnapshot;
  /** The `value_set_members.id`, which is what the audit row identifies. */
  readonly memberId: string;
  readonly auditEventId: string;
}

/**
 * A retire, where `auditEventId` is absent exactly when nothing changed.
 *
 * Typed separately from `ValueSetMemberWrite` rather than making the id optional on
 * both: a create ALWAYS writes an audit row, in the same transaction, so a type
 * admitting otherwise would push a `?? ''` into the caller — and
 * `stageCommittedAuditEntry` rejects an empty id precisely because it would defeat
 * the coverage check it exists to support.
 */
export type ValueSetMemberRetirement =
  | ValueSetMemberWrite
  | {
      readonly member: ValueSetMemberSnapshot;
      readonly memberId: string;
      readonly auditEventId?: undefined;
    };

/**
 * Admin configuration writes for value-set members (P3.S3, ADR-0008).
 *
 * ## Two rules this module exists to enforce
 *
 * **Retired, never deleted.** A clinical record references a member by code, so a
 * deleted code makes a stored entry unreadable — and the failure is silent and
 * retrospective. `retireMember` sets a status; nothing here issues a DELETE.
 *
 * **Audited in the same transaction as the write.** ADR-0008 requires every admin
 * configuration change to carry admin identity and before/after values into the
 * same append-only store as PHI changes. It is written via
 * `AuditService.record(context, tx)` INSIDE the transaction, for the reason P2.S1a
 * established for observations: `AuditInterceptor` runs after the handler's
 * observable emits, so a staged entry is a second transaction, and a crash between
 * the two leaves a configuration change with no audit row — undetectable
 * afterwards, because the changed row looks perfectly legitimate.
 */
/** The Prisma row shape all three paths project from. */
interface MemberRow {
  readonly code: string;
  readonly sortOrder: number;
  readonly numericValue: { toNumber: () => number } | null;
  readonly numericUnit: string | null;
  readonly status: 'ACTIVE' | 'RETIRED';
  readonly retiredAt: Date | null;
}

/** One place, so the audit snapshot and the read projection cannot drift apart. */
function toSnapshot(valueSetKey: string, row: MemberRow): ValueSetMemberSnapshot {
  return {
    valueSetKey,
    code: row.code,
    sortOrder: row.sortOrder,
    numericValue: toNumericValue(row.numericValue),
    numericUnit: row.numericUnit,
    status: row.status,
    retiredAt: row.retiredAt === null ? null : row.retiredAt.toISOString(),
  };
}

@Injectable()
export class AdminValueSetsService {
  // Explicit `@Inject()`, not implicit type-based injection — see `AuditService`'s
  // constructor comment for why the latter resolves to `undefined` under this
  // workspace's Vitest (esbuild) transform.
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ThresholdsService) private readonly thresholds: ThresholdsService,
  ) {}

  /**
   * Every set in the table, with every member, retired ones included.
   *
   * Deliberately not filtered by `PUBLISHED_VALUE_SET_KEYS`. That list is what a
   * patient client may render, and an admin managing configuration has to see the
   * sets a feature has not shipped yet — otherwise the only way to inspect them is
   * the database, which is what this surface exists to replace.
   *
   * A read, so no audit row: SRS §5.2 scopes audit logging to create/edit/delete,
   * and this carries no patient identifier and no PHI.
   */
  async listValueSets(): Promise<AdminValueSetsResponse> {
    const sets = await this.prisma.valueSet.findMany({
      orderBy: { key: 'asc' },
      include: { members: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }] } },
    });

    return {
      valueSets: sets.map((set) => ({
        key: set.key,
        members: set.members.map((member) => toSnapshot(set.key, member)),
      })),
    };
  }

  /**
   * Adds a member to an existing set.
   *
   * It cannot create a SET, and that is not an omission. Which sets exist is a
   * release decision — `PUBLISHED_VALUE_SET_KEYS` names the ones a client may
   * render, and a set that no shipped screen reads is a set a patient cannot use.
   * Creating one through this API would produce configuration no client knows
   * about, which is the shape of the P3.S2 defect where `urine_color` existed in
   * the table and reached no device.
   */
  async addMember(
    valueSetKey: string,
    request: AddValueSetMemberRequest,
    adminId: string,
    correlationId: string | undefined,
  ): Promise<ValueSetMemberWrite> {
    const write = await this.prisma.$transaction(async (tx) => {
      const valueSet = await tx.valueSet.findUnique({ where: { key: valueSetKey } });
      if (!valueSet) {
        throw new NotFoundException({ error: { code: 'VALUE_SET_NOT_FOUND' } });
      }

      const existing = await tx.valueSetMember.findUnique({
        where: { valueSetId_code: { valueSetId: valueSet.id, code: request.code } },
      });
      if (existing) {
        // Including a RETIRED one, deliberately. Re-adding a retired code would
        // give one code two meanings across time, which is precisely what
        // "no admin action may change what a past entry means" forbids — a reader
        // of an old entry cannot know which era it belongs to.
        throw new ConflictException({ error: { code: 'VALUE_SET_MEMBER_CODE_IN_USE' } });
      }

      /**
       * The check above is a fast path for a readable error; THIS is the guarantee.
       *
       * `$transaction` runs at the database default isolation (READ COMMITTED), so two
       * concurrent adds of one code both see no row and both insert. The second blocks
       * on `@@unique([valueSetId, code])` and fails at the first's commit — correctly,
       * but as a Prisma error, which is not an `HttpException` and so reached the admin
       * as an opaque 500 instead of the conflict it is.
       */
      let created;
      try {
        created = await tx.valueSetMember.create({
          data: {
            valueSetId: valueSet.id,
            code: request.code,
            sortOrder: request.sortOrder,
            numericValue: request.numericValue,
            numericUnit: request.numericUnit,
            status: 'ACTIVE',
          },
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new ConflictException({ error: { code: 'VALUE_SET_MEMBER_CODE_IN_USE' } });
        }
        throw error;
      }

      const after = toSnapshot(valueSetKey, created);

      const auditEvent = await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'CREATE',
          entityType: VALUE_SET_MEMBER_ENTITY_TYPE,
          entityId: created.id,
          // Carried for the same reason `observations.service.ts` and
          // `sync-push.service.ts` carry it: without it an admin configuration change
          // cannot be tied back to a request in the logs, on the one surface where
          // "who did this, in which request" is the entire point.
          //
          // Spread-or-omit, not `correlationId: value`: `exactOptionalPropertyTypes`
          // rejects an explicit `undefined` for an optional property, and the key must
          // be absent rather than present-and-undefined.
          ...(correlationId !== undefined ? { correlationId } : {}),
          // No `beforeValue`: nothing existed. Left absent rather than set to an
          // empty object, so a reader can tell "this is a creation" from "the
          // before state was not captured".
          afterValue: after,
        },
        tx,
      );

      return { member: after, memberId: created.id, auditEventId: auditEvent.id };
    });

    // After the transaction commits, never inside it: invalidating a cache for a
    // write that then rolls back would serve a re-read of the OLD row as though it
    // were news. The cache is per-process and not cluster-wide — see
    // `ThresholdsService`'s class comment, which records that limit and the two
    // ways out of it.
    this.thresholds.invalidate();
    return write;
  }

  /**
   * Withdraws a member from future entry without changing what past entries mean.
   *
   * Idempotent on an already-retired member: it answers the same snapshot and
   * writes no second audit row. A retry that produced a duplicate row in an
   * append-only table would be uncorrectable, since no `DELETE` grant exists
   * anywhere (ADR-0011).
   */
  async retireMember(
    valueSetKey: string,
    code: string,
    adminId: string,
    correlationId: string | undefined,
  ): Promise<ValueSetMemberRetirement> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const valueSet = await tx.valueSet.findUnique({ where: { key: valueSetKey } });
      if (!valueSet) {
        throw new NotFoundException({ error: { code: 'VALUE_SET_NOT_FOUND' } });
      }

      const member = await tx.valueSetMember.findUnique({
        where: { valueSetId_code: { valueSetId: valueSet.id, code } },
      });
      if (!member) {
        throw new NotFoundException({ error: { code: 'VALUE_SET_MEMBER_NOT_FOUND' } });
      }

      const before = toSnapshot(valueSetKey, member);

      /**
       * Conditional on the row still being `ACTIVE`, and `changed` derived from the
       * row count rather than from a status read above it.
       *
       * The previous shape read the status and then updated by id, so two concurrent
       * retires both saw `ACTIVE`, the second's `WHERE id = ...` still matched, and it
       * wrote a SECOND `UPDATE` audit row for a transition that had already happened.
       * `audit_events` has no `DELETE` grant anywhere (ADR-0011), so that duplicate is
       * permanent — which is precisely what this method's idempotency exists to avoid,
       * and what a sequential test cannot see.
       */
      const retiredAt = new Date();
      const { count } = await tx.valueSetMember.updateMany({
        where: { id: member.id, status: 'ACTIVE' },
        // `retired_at` as well as the status. The column exists and the init
        // migration specifies the operation as setting both; this is its only
        // writer, so without it every retired member has `retired_at IS NULL`
        // forever and "retired before release X" silently answers nothing.
        data: { status: 'RETIRED', retiredAt },
      });
      if (count === 0) {
        return {
          write: { member: before, memberId: member.id, auditEventId: undefined },
          changed: false,
        };
      }
      const after: ValueSetMemberSnapshot = {
        ...before,
        status: 'RETIRED',
        retiredAt: retiredAt.toISOString(),
      };

      // `UPDATE`, not `DELETE`. The action names what happened to the row, and the
      // row still exists — recording a DELETE would tell a future reader the code
      // is gone, which is the opposite of the guarantee this method provides.
      const auditEvent = await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'UPDATE',
          entityType: VALUE_SET_MEMBER_ENTITY_TYPE,
          entityId: member.id,
          ...(correlationId !== undefined ? { correlationId } : {}),
          beforeValue: before,
          afterValue: after,
        },
        tx,
      );

      return {
        write: { member: after, memberId: member.id, auditEventId: auditEvent.id },
        changed: true,
      };
    });

    if (outcome.changed) this.thresholds.invalidate();
    return outcome.write;
  }
}
