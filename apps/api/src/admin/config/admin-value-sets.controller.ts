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
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';

import type { OpenApiSchemaObject } from '../../observations/observation-openapi';

import { Audited } from '../../audit/audited.decorator';
import { stageCommittedAuditEntry } from '../../audit/audit-recorder';
import { getRequestId } from '../../logging/request-id';
import { getAdminActor } from '../admin-actor';
import { AdminJwtAuthGuard } from '../admin-jwt-auth.guard';
import { toAdminErrorFields } from './wire-errors';

import {
  addValueSetMemberSchema,
  adminValueSetsResponseSchema,
  type AdminValueSetsResponse,
  type ValueSetMemberSnapshot,
} from './admin-value-set-wire';
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
/**
 * Converted once, so the `.meta({ description })` text in the wire module actually
 * reaches the document.
 *
 * It did not before: the routes carried `@ApiOperation` alone, so `openapi.json`
 * described them with `"parameters": []` and no request body — not merely sparse but
 * structurally invalid, since `{key}` and `{code}` are path-templated. That is the
 * document the P8 console will be generated from, and it is the reason the wire
 * module's response schemas were unused outside their own file.
 */
const ADD_MEMBER_BODY_SCHEMA: OpenApiSchemaObject = z.toJSONSchema(addValueSetMemberSchema, {
  target: 'openapi-3.0',
  io: 'input',
}) as OpenApiSchemaObject;
const VALUE_SETS_RESPONSE_SCHEMA: OpenApiSchemaObject = z.toJSONSchema(
  adminValueSetsResponseSchema,
  { target: 'openapi-3.0' },
) as OpenApiSchemaObject;
const ERROR_CODE_SCHEMA: OpenApiSchemaObject = {
  type: 'object',
  properties: { error: { type: 'object', properties: { code: { type: 'string' } } } },
} as OpenApiSchemaObject;

@ApiTags('admin-config')
@ApiBearerAuth('admin-oidc')
@Controller('admin/value-sets')
@UseGuards(AdminJwtAuthGuard)
export class AdminValueSetsController {
  constructor(@Inject(AdminValueSetsService) private readonly service: AdminValueSetsService) {}

  @Get()
  @ApiOkResponse({ schema: VALUE_SETS_RESPONSE_SCHEMA })
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
  @ApiParam({ name: 'key', description: 'The value set to add to. It must already exist.' })
  @ApiBody({ schema: ADD_MEMBER_BODY_SCHEMA })
  @ApiConflictResponse({ schema: ERROR_CODE_SCHEMA })
  @ApiNotFoundResponse({ schema: ERROR_CODE_SCHEMA })
  @ApiOperation({
    summary: 'Add a member to an existing value set',
    description:
      'The code is permanent once created: stored clinical entries resolve their meaning through it, so there is no endpoint that edits one. A mistake is withdrawn by retiring it and adding a replacement, which leaves old entries meaning what they meant.',
  })
  async addMember(
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ValueSetMemberSnapshot> {
    // Parsed here rather than by a global `ValidationPipe`: the same reason
    // `docs/sync-contract.md` gives for validating sync payloads per operation —
    // a schema applied by framework configuration is a schema nobody reads at the
    // call site, and this one carries a rule (numericValue and numericUnit travel
    // together) that is a contract, not a formality.
    const parsed = addValueSetMemberSchema.safeParse(body);
    if (!parsed.success) {
      /**
       * Field paths and reason codes, never values. The offending input is
       * administrative rather than clinical here, but the habit is the rule
       * (CLAUDE.md): a validation error names the field and the rule, never the value.
       *
       * The reason code is carried because the path alone is not always enough. An
       * unrecognised key reports `path: []`, so the two most interesting rejections —
       * an unknown field, and the both-or-neither `numericValue`/`numericUnit` rule —
       * named no field at all. Zod's issue codes are a closed vocabulary, so they leak
       * nothing. `message` is deliberately still dropped: it can quote the input.
       */
      throw new BadRequestException({
        error: {
          code: 'INVALID_VALUE_SET_MEMBER',
          // `toAdminErrorFields` (#100). The mapping here carried the rule code but
          // never expanded `unrecognized_keys`, so an unknown key still reported
          // `field: ''` — the comment above describes adding the reason code, which
          // it did, and not the field name, which it did not. This surface has no
          // immutable fields of its own: every key it refuses is simply unknown.
          fields: toAdminErrorFields(parsed.error),
        },
      });
    }

    const admin = getAdminActor(request);
    const write = await this.service.addMember(key, parsed.data, admin.id, getRequestId(request));
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
    // The persisted snapshot, not just the code: `numericValue` is stored in a
    // `DECIMAL(12,4)` column, and echoing what was written is how an admin sees that
    // what they typed is what governs. The schema now rejects values the column
    // cannot hold, so this is belt-and-braces rather than the only guard.
    return write.member;
  }

  @Post(':key/members/:code/retire')
  @HttpCode(200)
  @ApiParam({ name: 'key', description: 'The value set the member belongs to.' })
  @ApiParam({
    name: 'code',
    description: 'The member code to withdraw. It keeps resolving for stored entries.',
  })
  @ApiNotFoundResponse({ schema: ERROR_CODE_SCHEMA })
  // `allowEmpty` because retiring an already-retired member legitimately records
  // nothing: no row changed, so there is nothing to describe, and a second audit row
  // for a no-op would be uncorrectable in an append-only table with no DELETE grant
  // anywhere (ADR-0011). The default — treat "staged nothing" as a forgotten call and
  // fail the request — is right for a single-entity write and wrong here, the same
  // argument sync push made for this escape hatch.
  //
  // The cost, stated: it disables the trip-wire for BOTH branches, so the
  // `auditEventId !== undefined` guard below is what keeps staging and writing in
  // step. A line comment rather than a `/** */` block because a doc block between
  // decorators attaches to nothing and never appears on hover.
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
  ): Promise<{ code: string; status: string; retiredAt: string | null }> {
    const admin = getAdminActor(request);
    const write = await this.service.retireMember(key, code, admin.id, getRequestId(request));
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
    // Says which happened. A caller could not previously tell a fresh retirement from
    // a no-op, and inferring it from the absence of an audit id would couple a
    // response decision to an audit-logging detail.
    return {
      code: write.member.code,
      status: write.member.status,
      retiredAt: write.member.retiredAt,
    };
  }
}
