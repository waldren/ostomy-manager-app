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
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { Audited } from '../../audit/audited.decorator';
import { stageCommittedAuditEntry } from '../../audit/audit-recorder';
import { getAdminActor } from '../admin-actor';
import { AdminJwtAuthGuard } from '../admin-jwt-auth.guard';

import { addValueSetMemberSchema, type AdminValueSetsResponse } from './admin-value-set-wire';
import { AdminValueSetsService, VALUE_SET_MEMBER_ENTITY_TYPE } from './admin-value-sets.service';

/**
 * The value-set half of the admin configuration API (P3.S3, ADR-0008).
 *
 * `AdminJwtAuthGuard` at the class level, never a global guard — the convention
 * `admin-stub.controller.ts` set for every controller under `src/admin/**`, so the
 * boundary stays auditable file by file as this surface grows.
 *
 * ADR-0008 calls this "final shape" and means it: the console at P8 is this API's
 * first UI client, not the point at which it gets hardened. The failure mode that
 * ADR names — a shared guard with a role check, unaudited writes, hard deletes on
 * members — is what these three routes are shaped against.
 *
 * Not in the generated patient client: `scripts/generate-api-client.cjs` excludes
 * `/api/v1/admin` because `createApiClient` has one token supplier documented as the
 * patient access token, and emitting these would produce methods callable only with
 * the wrong pool's credential. P3.S3 owns that decision and keeps it — a second
 * client needs its own `packages/core` subpath, its own ESLint allow-list entry and
 * an ADR-0007 owner, and `apps/admin` does not exist until P8.S1.
 */
@ApiTags('admin-config')
@ApiBearerAuth('admin-oidc')
@Controller('admin/value-sets')
@UseGuards(AdminJwtAuthGuard)
export class AdminValueSetsController {
  constructor(@Inject(AdminValueSetsService) private readonly service: AdminValueSetsService) {}

  @Get()
  @ApiOperation({
    summary: 'Read every value set, including retired members',
    description:
      'The whole configuration table, not the published subset a patient client reads, and with retirement visible rather than expressed by absence. A read: no audit row, no patient identifier, no PHI.',
  })
  async list(): Promise<AdminValueSetsResponse> {
    return this.service.listValueSets();
  }

  @Post(':key/members')
  @Audited()
  @ApiOperation({
    summary: 'Add a member to an existing value set',
    description:
      'The code is permanent once created: stored clinical entries resolve their meaning through it, so there is no endpoint that edits one. A mistake is withdrawn by retiring it and adding a replacement, which leaves old entries meaning what they meant.',
  })
  async addMember(
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<{ code: string }> {
    // Parsed here rather than by a global `ValidationPipe`: the same reason
    // `docs/sync-contract.md` gives for validating sync payloads per operation —
    // a schema applied by framework configuration is a schema nobody reads at the
    // call site, and this one carries a rule (numericValue and numericUnit travel
    // together) that is a contract, not a formality.
    const parsed = addValueSetMemberSchema.safeParse(body);
    if (!parsed.success) {
      // Field paths and no values. The offending input is administrative rather
      // than clinical here, but the habit is the rule (CLAUDE.md): a validation
      // error names the field and the rule, never the value.
      throw new BadRequestException({
        code: 'INVALID_VALUE_SET_MEMBER',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }

    const admin = getAdminActor(request);
    const write = await this.service.addMember(key, parsed.data, admin.id);
    // Staged as already-committed, because the service wrote it inside the same
    // transaction as the row it describes. The id is the proof the interceptor
    // checks, which is why the service returns it.
    stageCommittedAuditEntry(
      request,
      {
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'CREATE',
        entityType: VALUE_SET_MEMBER_ENTITY_TYPE,
        entityId: write.memberId,
      },
      // Required by the type, because a member cannot be added without an audit row
      // — both happen in one transaction.
      write.auditEventId,
    );
    return { code: write.member.code };
  }

  @Post(':key/members/:code/retire')
  @HttpCode(200)
  /**
   * `allowEmpty` because retiring an already-retired member legitimately records
   * nothing: no row changed, so there is nothing to describe, and writing a second
   * audit row for a no-op would be uncorrectable in an append-only table with no
   * DELETE grant anywhere (ADR-0011). The default behaviour — treat "staged nothing"
   * as a forgotten call and fail the request — is right for a single-entity write and
   * wrong here, which is the same argument sync push made for this escape hatch.
   */
  @Audited({ allowEmpty: true })
  @ApiOperation({
    summary: 'Retire a member, so it stops being offered without ceasing to resolve',
    description:
      'A status change, never a delete. A retired code disappears from what a patient client renders and still resolves when reading history, which is what keeps a stored entry meaningful. Idempotent: retiring an already-retired member changes nothing and writes no second audit row.',
  })
  async retireMember(
    @Param('key') key: string,
    @Param('code') code: string,
    @Req() request: Request,
  ): Promise<{ code: string; status: string }> {
    const admin = getAdminActor(request);
    const write = await this.service.retireMember(key, code, admin.id);
    if (write.auditEventId !== undefined) {
      stageCommittedAuditEntry(
        request,
        {
          actorType: 'ADMIN',
          actorId: admin.id,
          // `UPDATE`: the row still exists. Recording a DELETE would tell a future
          // reader the code is gone, which is the opposite of what retirement means.
          action: 'UPDATE',
          entityType: VALUE_SET_MEMBER_ENTITY_TYPE,
          entityId: write.memberId,
        },
        write.auditEventId,
      );
    }
    return { code: write.member.code, status: write.member.status };
  }
}
