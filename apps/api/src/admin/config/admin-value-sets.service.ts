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
import { PrismaService } from '../../prisma/prisma.service';
import { ThresholdsService } from '../../thresholds/thresholds.service';

import type {
  AddValueSetMemberRequest,
  AdminValueSetsResponse,
  ValueSetMemberSnapshot,
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
        members: set.members.map((member) => ({
          code: member.code,
          sortOrder: member.sortOrder,
          numericValue: member.numericValue === null ? null : member.numericValue.toNumber(),
          numericUnit: member.numericUnit,
          status: member.status,
        })),
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
  ): Promise<ValueSetMemberWrite> {
    const write = await this.prisma.$transaction(async (tx) => {
      const valueSet = await tx.valueSet.findUnique({ where: { key: valueSetKey } });
      if (!valueSet) {
        throw new NotFoundException({ code: 'VALUE_SET_NOT_FOUND' });
      }

      const existing = await tx.valueSetMember.findFirst({
        where: { valueSetId: valueSet.id, code: request.code },
      });
      if (existing) {
        // Including a RETIRED one, deliberately. Re-adding a retired code would
        // give one code two meanings across time, which is precisely what
        // "no admin action may change what a past entry means" forbids — a reader
        // of an old entry cannot know which era it belongs to.
        throw new ConflictException({ code: 'VALUE_SET_MEMBER_CODE_IN_USE' });
      }

      const created = await tx.valueSetMember.create({
        data: {
          valueSetId: valueSet.id,
          code: request.code,
          sortOrder: request.sortOrder,
          numericValue: request.numericValue,
          numericUnit: request.numericUnit,
          status: 'ACTIVE',
        },
      });

      const after: ValueSetMemberSnapshot = {
        valueSetKey,
        code: created.code,
        sortOrder: created.sortOrder,
        numericValue: created.numericValue === null ? null : created.numericValue.toNumber(),
        numericUnit: created.numericUnit,
        status: created.status,
      };

      const auditEvent = await this.audit.record(
        {
          actorType: 'ADMIN',
          actorId: adminId,
          action: 'CREATE',
          entityType: VALUE_SET_MEMBER_ENTITY_TYPE,
          entityId: created.id,
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
  ): Promise<ValueSetMemberRetirement> {
    const outcome = await this.prisma.$transaction(async (tx) => {
      const valueSet = await tx.valueSet.findUnique({ where: { key: valueSetKey } });
      if (!valueSet) {
        throw new NotFoundException({ code: 'VALUE_SET_NOT_FOUND' });
      }

      const member = await tx.valueSetMember.findFirst({
        where: { valueSetId: valueSet.id, code },
      });
      if (!member) {
        throw new NotFoundException({ code: 'VALUE_SET_MEMBER_NOT_FOUND' });
      }

      const before: ValueSetMemberSnapshot = {
        valueSetKey,
        code: member.code,
        sortOrder: member.sortOrder,
        numericValue: member.numericValue === null ? null : member.numericValue.toNumber(),
        numericUnit: member.numericUnit,
        status: member.status,
      };

      if (member.status === 'RETIRED') {
        return {
          write: { member: before, memberId: member.id, auditEventId: undefined },
          changed: false,
        };
      }

      const updated = await tx.valueSetMember.update({
        where: { id: member.id },
        data: { status: 'RETIRED' },
      });
      const after: ValueSetMemberSnapshot = { ...before, status: updated.status };

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
