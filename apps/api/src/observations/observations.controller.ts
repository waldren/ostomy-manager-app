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

/**
 * `POST /api/v1/observations` and `GET /api/v1/observations` — stoma output.
 *
 * There is no patient identifier in any route parameter, query string or
 * body on this controller, and there must never be one: the patient is the
 * subject of the presented token (`docs/sync-contract.md` §2). That is not
 * defence in depth, it is the absence of the field that could carry the
 * attack.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Request } from 'express';

import { Audited } from '../audit/audited.decorator';
import { getPatientActor } from '../auth/patient-actor';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { toObservationResource } from './observation-payload';
import { ObservationBodyPipe } from './observation-body.pipe';
import {
  OBSERVATION_CREATE_RESPONSE_SCHEMA,
  OBSERVATION_ERROR_RESPONSE_SCHEMA,
  OBSERVATION_LIST_RESPONSE_SCHEMA,
  OBSERVATION_REQUEST_SCHEMA,
} from './observation-openapi';
import { ObservationQueryPipe, type ObservationListQuery } from './observation-query.pipe';
import { observationNotFound } from './observation-rejection';
import type { ObservationRequestParsed, ObservationResource } from './observation-wire';
import {
  ObservationsService,
  type ObservationCreateResult,
  type ObservationListResult,
} from './observations.service';

const ERROR_RESPONSE = { schema: OBSERVATION_ERROR_RESPONSE_SCHEMA } as const;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

@ApiTags('observations')
@ApiBearerAuth('patient-oidc')
@Controller('observations')
@UseGuards(JwtAuthGuard)
export class ObservationsController {
  // Explicit `@Inject()`, not implicit type-based injection — see
  // `AuditService`'s constructor comment for why the latter resolves to
  // `undefined` under this workspace's Vitest (esbuild) transform.
  constructor(@Inject(ObservationsService) private readonly observations: ObservationsService) {}

  @Post()
  // Route-level audit coverage (P1.S5). The write itself stages a *committed*
  // entry — the audit row is written inside the observation's own
  // transaction — so this decorator's job here is the trip-wire: a future
  // edit that drops the audit call fails the request rather than silently
  // writing PHI with no audit row.
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Record one stoma-output observation',
    description:
      'Creates one observation. The payload is FHIR R4 shaped and identical to the sync wire payload (docs/sync-contract.md §7.2). Every packages/core Tier 1 rule is re-enforced here regardless of client-side validation; a Tier 2 warning is returned alongside a successful write and never blocks it.',
  })
  @ApiBody({ schema: OBSERVATION_REQUEST_SCHEMA })
  @ApiCreatedResponse({ schema: OBSERVATION_CREATE_RESPONSE_SCHEMA })
  @ApiBadRequestResponse(ERROR_RESPONSE)
  @ApiUnprocessableEntityResponse(ERROR_RESPONSE)
  @ApiConflictResponse(ERROR_RESPONSE)
  @ApiForbiddenResponse(ERROR_RESPONSE)
  async create(
    @Req() request: Request,
    @Body(ObservationBodyPipe) body: ObservationRequestParsed,
  ): Promise<ObservationCreateResult> {
    return this.observations.create(getPatientActor(request), request, body);
  }

  @Get()
  @ApiOperation({
    summary: "List this patient's stoma-output observations",
    description:
      "Returns this patient's observations, most recent clinical moment first. Reads are not PHI mutations and are not audit events (SRS §5.2).",
  })
  @ApiQuery({
    name: 'effectiveDateTimeFrom',
    required: false,
    schema: { type: 'string', format: 'date-time' },
    description:
      'Inclusive lower bound on effectiveDateTime. RFC 3339, UTC, three fractional digits.',
  })
  @ApiQuery({
    name: 'effectiveDateTimeTo',
    required: false,
    schema: { type: 'string', format: 'date-time' },
    description:
      'Inclusive upper bound on effectiveDateTime. RFC 3339, UTC, three fractional digits.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer' },
    description: 'Page size. Clamped to the server maximum rather than refused.',
  })
  @ApiOkResponse({ schema: OBSERVATION_LIST_RESPONSE_SCHEMA })
  @ApiBadRequestResponse(ERROR_RESPONSE)
  @ApiForbiddenResponse(ERROR_RESPONSE)
  async list(
    @Req() request: Request,
    @Query(ObservationQueryPipe) query: ObservationListQuery,
  ): Promise<ObservationListResult> {
    return this.observations.list(getPatientActor(request), query);
  }

  @Get(':id')
  @ApiOperation({
    summary: "Read one of this patient's observations",
    description:
      "Returns 404 both when no such observation exists and when it belongs to another patient — the lookup is scoped to (patient, id) together and never learns the difference, so this endpoint cannot be used to confirm that another patient's row exists.",
  })
  @ApiParam({
    name: 'id',
    required: true,
    schema: { type: 'string', format: 'uuid' },
    description: 'The observation id. Resolved against this patient only.',
  })
  @ApiOkResponse({ schema: OBSERVATION_REQUEST_SCHEMA })
  @ApiNotFoundResponse(ERROR_RESPONSE)
  @ApiForbiddenResponse(ERROR_RESPONSE)
  async findOne(@Req() request: Request, @Param('id') id: string): Promise<ObservationResource> {
    // A syntactically impossible id cannot name any row, and must not reach
    // the query: Postgres raises `invalid input syntax for type uuid`, which
    // would surface as a 500 carrying a database error. Nest's own
    // `ParseUUIDPipe` would reject it, but with the framework's
    // `{statusCode,message,error}` body — a second error shape on the same
    // endpoint. 404 keeps one shape, and is the truthful answer.
    if (!isUuid(id)) {
      throw observationNotFound();
    }
    const row = await this.observations.findOne(getPatientActor(request), id);
    if (!row) {
      throw observationNotFound();
    }
    return toObservationResource(row);
  }
}
