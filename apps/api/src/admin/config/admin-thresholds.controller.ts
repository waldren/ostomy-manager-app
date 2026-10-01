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
  Inject,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
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

import {
  adminThresholdsResponseSchema,
  updateThresholdSchema,
  type AdminThresholdsResponse,
  type ThresholdSnapshot,
} from './admin-threshold-wire';
import { AdminThresholdsService, THRESHOLD_ENTITY_TYPE } from './admin-thresholds.service';

const UPDATE_BODY_SCHEMA: OpenApiSchemaObject = z.toJSONSchema(updateThresholdSchema, {
  target: 'openapi-3.0',
  io: 'input',
}) as OpenApiSchemaObject;
const THRESHOLDS_RESPONSE_SCHEMA: OpenApiSchemaObject = z.toJSONSchema(
  adminThresholdsResponseSchema,
  { target: 'openapi-3.0' },
) as OpenApiSchemaObject;
const ERROR_CODE_SCHEMA: OpenApiSchemaObject = {
  type: 'object',
  properties: { error: { type: 'object', properties: { code: { type: 'string' } } } },
} as OpenApiSchemaObject;

/**
 * The threshold half of the admin configuration API (P3.S3 PR B, ADR-0008).
 *
 * `AdminJwtAuthGuard` at the class level, never a global guard — the convention every
 * controller under `src/admin/**` follows, so the boundary stays auditable file by
 * file as this surface grows.
 *
 * This is the endpoint SRS §3.8 and AC 13.2 AC2 have been waiting for: until now a
 * numeric validation bound could only be changed by editing a migration, which R7
 * records as the live half of that risk. The bound itself has always been injected
 * data rather than a constant — that was ADR-0008's whole point in building the tables
 * early — so nothing in the validation layer changes to make this work.
 *
 * `PUT`, not `PATCH`: the body is the complete new state of the two mutable fields,
 * and a `PATCH` would invite the field-by-field merge that makes "what did this change
 * actually do" unanswerable from the request alone.
 */
@ApiTags('admin-config')
@ApiBearerAuth('admin-oidc')
@Controller('admin/thresholds')
@UseGuards(AdminJwtAuthGuard)
export class AdminThresholdsController {
  constructor(@Inject(AdminThresholdsService) private readonly service: AdminThresholdsService) {}

  @Get()
  @ApiOkResponse({ schema: THRESHOLDS_RESPONSE_SCHEMA })
  @ApiOperation({
    summary: 'Read every validation threshold',
    description:
      'The whole table, unfiltered, including thresholds no clinical rule reads yet. The only way to discover a key before changing one, since the keys a client reads live in the server source. A read: no audit row, no patient identifier, no PHI.',
  })
  async list(): Promise<AdminThresholdsResponse> {
    return this.service.listThresholds();
  }

  @Put(':key')
  @Audited()
  @ApiParam({
    name: 'key',
    description:
      'The threshold_key. It must already exist: there is no upsert, because a key this table does not hold is configuration no clinical rule reads.',
  })
  @ApiBody({ schema: UPDATE_BODY_SCHEMA })
  @ApiNotFoundResponse({ schema: ERROR_CODE_SCHEMA })
  @ApiOperation({
    summary: "Change a threshold's value",
    description:
      'Governs from the next client fetch, with no application release (AC 13.2 AC2). Only the value and the admin-tool label may change: the tier is immutable, because a warning must never become a block, and the key, unit and patient-adjustable flag are immutable for reasons the wire module sets out. Both before and after values reach the audit log.',
  })
  async update(
    @Param('key') key: string,
    @Body() body: unknown,
    @Req() request: Request,
  ): Promise<ThresholdSnapshot> {
    const parsed = updateThresholdSchema.safeParse(body);
    if (!parsed.success) {
      // Field paths and reason codes, never values — the same envelope and the same
      // reasoning as the value-set surface. `message` is dropped because it can quote
      // the input; Zod's issue codes are a closed vocabulary and leak nothing.
      //
      // `.strict()` is doing real work on this route in particular: a caller who sends
      // `tier` is told so rather than having it silently ignored, which is the
      // difference between a refused change and a change someone believes they made.
      throw new BadRequestException({
        error: {
          code: 'INVALID_THRESHOLD_UPDATE',
          fields: parsed.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            rule: issue.code,
          })),
        },
      });
    }

    const admin = getAdminActor(request);
    const write = await this.service.updateThreshold(
      key,
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
        entityType: THRESHOLD_ENTITY_TYPE,
        entityId: write.thresholdId,
      },
      write.auditEventId,
    );
    // The persisted row, so an admin sees the value that now governs rather than the
    // one they sent. The schema already rejects what the column cannot hold, so this
    // is confirmation rather than the guard.
    return write.threshold;
  }
}
