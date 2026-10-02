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
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';

/**
 * A malformed row id, reported in this surface's own vocabulary.
 *
 * `ParseUUIDPipe`'s default throws `BadRequestException('Validation failed (uuid is
 * expected)')`, whose body carries `statusCode` and `message` — so
 * `ErrorSanitizerFilter` correctly refuses to forward it and rewrites it to
 * `{ error: { code: 'BAD_REQUEST' } }`. Safe, and inconsistent: a malformed id would
 * answer `BAD_REQUEST` while a malformed body answers
 * `INVALID_DEFAULT_RANGE_UPDATE`. An authored body with neither key passes the
 * filter untouched and keeps the code set closed.
 */
export const rowIdPipe = new ParseUUIDPipe({
  exceptionFactory: () => new BadRequestException({ error: { code: 'INVALID_DEFAULT_RANGE_ID' } }),
});
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';

import { stageCommittedAuditEntry } from '../../audit/audit-recorder';
import { Audited } from '../../audit/audited.decorator';
import { getRequestId } from '../../logging/request-id';
import type { OpenApiSchemaObject } from '../../observations/observation-openapi';
import { getAdminActor } from '../admin-actor';
import { AdminJwtAuthGuard } from '../admin-jwt-auth.guard';
import { toAdminErrorFields } from './wire-errors';

import {
  IDENTITY_FIELDS,
  adminDefaultRangeSchema,
  adminDefaultRangesResponseSchema,
  createDefaultRangeSchema,
  deletedDefaultRangeSchema,
  updateDefaultRangeSchema,
  type AdminDefaultRange,
  type AdminDefaultRangesResponse,
  type DeletedDefaultRange,
} from './admin-default-range-wire';
import {
  AdminDefaultRangesService,
  DEFAULT_RANGE_ENTITY_TYPE,
} from './admin-default-ranges.service';

const toSchema = (schema: z.ZodType, io: 'input' | 'output' = 'output'): OpenApiSchemaObject =>
  z.toJSONSchema(schema, { target: 'openapi-3.0', io }) as OpenApiSchemaObject;

const CREATE_BODY_SCHEMA = toSchema(createDefaultRangeSchema, 'input');
const UPDATE_BODY_SCHEMA = toSchema(updateDefaultRangeSchema, 'input');
const RANGE_RESPONSE_SCHEMA = toSchema(adminDefaultRangeSchema);
const DELETED_RANGE_RESPONSE_SCHEMA = toSchema(deletedDefaultRangeSchema);
const RANGES_RESPONSE_SCHEMA = toSchema(adminDefaultRangesResponseSchema);
const ERROR_CODE_SCHEMA: OpenApiSchemaObject = {
  type: 'object',
  properties: { error: { type: 'object', properties: { code: { type: 'string' } } } },
} as OpenApiSchemaObject;

/**
 * The fields the update surface refuses, for naming them in a 400.
 *
 * Intersected with Zod's reported keys rather than echoed, so the response can only
 * contain names from this list — a caller cannot get arbitrary input reflected back by
 * sending it as a key (PR B's review).
 *
 * Derived from the two schemas rather than listed, so a create-only field added later
 * is automatically identity and automatically refused here. A hardcoded list is how
 * `windowDays` came to be both mutable and part of the row's meaning.
 */
const IMMUTABLE_FIELDS = IDENTITY_FIELDS;

/**
 * The shape `wire-errors.ts` now generalises, and the only one of the three
 * copies that was right — because #96's review looked at it closely. Moved out
 * so the other two cannot keep drifting from it (#100).
 *
 * One visible change came with the move: an unrecognised key is reported as
 * `(unrecognized)` rather than the empty string. `''` collides with the
 * root-level case once anything renders these — a consumer doing
 * `field || '(body)'`, which `scripts/admin-config.mjs` does, turned "you sent a
 * key I do not know" into "the body itself is wrong".
 */
function refuse(code: string, error: z.ZodError): never {
  throw new BadRequestException({
    error: { code, fields: toAdminErrorFields(error, IMMUTABLE_FIELDS) },
  });
}

/**
 * The clinical-default-range half of the admin configuration API (P3.S3 PR C,
 * ADR-0008).
 *
 * `AdminJwtAuthGuard` at the class level, never a global guard — the convention every
 * controller under `src/admin/**` follows, so the boundary stays auditable file by file.
 *
 * This is the surface SRS §3.9's suggestion seeding will draw on, and the one that
 * holds the heart-rate red-flag bound once P7 seeds it (#94). Two things follow from
 * that and are worth knowing before changing anything here:
 *
 * - The table is **empty today and nothing reads it**. §3.9's seeding is P6/P7, so this
 *   API has no consumer yet. ADR-0008 puts the configuration surface before the console
 *   deliberately, so that is the plan rather than an oversight — but no clinical path
 *   exercises these routes, and a reviewer should not assume one does.
 * - Addressed by `id`, not by its type pair, because that pair is deliberately not
 *   unique: many rows share it and are told apart by their post-operative day window.
 *   Overlapping windows are the invariant this surface defends.
 */
@ApiTags('admin-config')
@ApiBearerAuth('admin-oidc')
@Controller('admin/default-ranges')
@UseGuards(AdminJwtAuthGuard)
export class AdminDefaultRangesController {
  constructor(
    @Inject(AdminDefaultRangesService) private readonly service: AdminDefaultRangesService,
  ) {}

  @Get()
  @ApiOkResponse({ schema: RANGES_RESPONSE_SCHEMA })
  @ApiOperation({
    summary: 'Read every clinical default range',
    description:
      'Ordered so the post-operative windows for one rule read in sequence. Population-level configuration: no patient identifier, no PHI, and therefore no audit row (SRS §5.2).',
  })
  async list(): Promise<AdminDefaultRangesResponse> {
    return this.service.listDefaultRanges();
  }

  @Post()
  @Audited()
  @ApiBody({ schema: CREATE_BODY_SCHEMA })
  @ApiCreatedResponse({ schema: RANGE_RESPONSE_SCHEMA })
  @ApiBadRequestResponse({ schema: ERROR_CODE_SCHEMA })
  @ApiConflictResponse({ schema: ERROR_CODE_SCHEMA })
  @ApiOperation({
    summary: 'Add a default range',
    description:
      'This surface has a create because the table is seeded by nothing: without one, §3.9 would have no defaults to seed suggestions from and no route to acquire any short of a migration. Every field is required — nullable rather than optional — so a body states the whole row rather than leaving a reader to guess what an absent key meant. A window overlapping an existing row of the same shape (ostomy type, range type and rolling window) is refused, because two rows matching one patient would make the seeding pick arbitrarily; rows sharing a range type carry the unit their clinical_default_range_limits row declares.',
  })
  async create(@Body() body: unknown, @Req() request: Request): Promise<AdminDefaultRange> {
    const parsed = createDefaultRangeSchema.safeParse(body);
    if (!parsed.success) refuse('INVALID_DEFAULT_RANGE', parsed.error);

    const admin = getAdminActor(request);
    const write = await this.service.createDefaultRange(
      parsed.data,
      admin.id,
      getRequestId(request),
    );
    stageCommittedAuditEntry(
      request,
      {
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'CREATE',
        entityType: DEFAULT_RANGE_ENTITY_TYPE,
        entityId: write.rangeId,
      },
      write.auditEventId,
    );
    return { ...write.range, id: write.rangeId, updatedAt: write.updatedAt };
  }

  @Put(':id')
  @Audited()
  @ApiParam({
    name: 'id',
    type: String,
    description: 'The row id. Not the type pair, which is not unique.',
  })
  @ApiBody({ schema: UPDATE_BODY_SCHEMA })
  @ApiOkResponse({ schema: RANGE_RESPONSE_SCHEMA })
  @ApiBadRequestResponse({ schema: ERROR_CODE_SCHEMA })
  @ApiConflictResponse({ schema: ERROR_CODE_SCHEMA })
  @ApiNotFoundResponse({ schema: ERROR_CODE_SCHEMA })
  @ApiOperation({
    summary: "Change a default range's bounds",
    description:
      "Only the rule's parameters. The ostomy type, range type, day window and unit are immutable: editing one turns the row into a different default rather than correcting this one, so a mistake there is a delete and a create.",
  })
  async update(
    @Param('id', rowIdPipe) id: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<AdminDefaultRange> {
    const parsed = updateDefaultRangeSchema.safeParse(body);
    if (!parsed.success) refuse('INVALID_DEFAULT_RANGE_UPDATE', parsed.error);

    const admin = getAdminActor(request);
    const write = await this.service.updateDefaultRange(
      id,
      parsed.data,
      admin.id,
      getRequestId(request),
    );
    stageCommittedAuditEntry(
      request,
      {
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'UPDATE',
        entityType: DEFAULT_RANGE_ENTITY_TYPE,
        entityId: write.rangeId,
      },
      write.auditEventId,
    );
    return { ...write.range, id: write.rangeId, updatedAt: write.updatedAt };
  }

  @Delete(':id')
  @HttpCode(200)
  @Audited()
  @ApiParam({ name: 'id', type: String })
  // `deletedDefaultRangeSchema`, not `adminDefaultRangeSchema`: the route used to
  // advertise a body with `id` and `updatedAt` both required while returning neither,
  // which both reviews caught. A row that no longer exists has no last-modified time.
  @ApiOkResponse({ schema: DELETED_RANGE_RESPONSE_SCHEMA })
  @ApiBadRequestResponse({ schema: ERROR_CODE_SCHEMA })
  @ApiConflictResponse({ schema: ERROR_CODE_SCHEMA })
  @ApiNotFoundResponse({ schema: ERROR_CODE_SCHEMA })
  @ApiOperation({
    summary: 'Remove a default range',
    description:
      "A real delete, unlike the value-set surface where a member is retired. Nothing references a default range: a patient's effective range carries its own bounds with CLINICAL_DEFAULT provenance, which is a copy rather than a pointer, so removing a default cannot alter a range any patient already has. The audit row keeps what the row said. One exception: a safety-class range type answers 409 SAFETY_RANGE_NOT_DELETABLE (#98). Such a row is migration-owned — seeded one per ostomy type, day 0 onward, ceiling only — and this surface refuses to create or delete one, leaving PUT as the only mutation. An earlier version of this description claimed DELETE was the only operation that could switch off a seek-care prompt; it was not. A PUT removing the ceiling did the same thing while answering 200, which is why the ceiling is now required on this type.",
  })
  async remove(
    @Param('id', rowIdPipe) id: string,
    @Req() request: Request,
  ): Promise<DeletedDefaultRange> {
    const admin = getAdminActor(request);
    const write = await this.service.deleteDefaultRange(id, admin.id, getRequestId(request));
    stageCommittedAuditEntry(
      request,
      {
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'DELETE',
        entityType: DEFAULT_RANGE_ENTITY_TYPE,
        entityId: write.rangeId,
      },
      write.auditEventId,
    );
    /**
     * The row as it was, plus its id.
     *
     * Not a 204, and the reason is not obvious: this body is the admin's only
     * non-audit copy of a row that no longer exists, and the audit log is not readable
     * through any API. A 204 would mean an admin who deleted the wrong row has to ask
     * an engineer to query `audit_events` to find out what to re-create.
     */
    return { ...write.range, id: write.rangeId };
  }
}
