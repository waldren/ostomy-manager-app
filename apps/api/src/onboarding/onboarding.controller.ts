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
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  UseGuards,
  UsePipes,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { z } from 'zod';

import { Audited } from '../audit/audited.decorator';
import { stageCommittedAuditEntry } from '../audit/audit-recorder';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { getPatientActor } from '../auth/patient-actor';
import { getRequestId } from '../logging/request-id';
import { OBSERVATION_ERROR_RESPONSE_SCHEMA } from '../observations/observation-openapi';

import { ZodBodyPipe } from './zod-body.pipe';
import {
  onboardingRequestSchema,
  profileResponseSchema,
  type OnboardingRequest,
  type ProfileResponse,
} from './onboarding-wire';
import { OnboardingService, PROFILE_ENTITY_TYPE } from './onboarding.service';

type OpenApiSchemaObject = Record<string, unknown>;

function toOpenApiSchema(schema: z.ZodType): OpenApiSchemaObject {
  return z.toJSONSchema(schema, { target: 'openapi-3.0' }) as OpenApiSchemaObject;
}

const ONBOARDING_REQUEST_SCHEMA = toOpenApiSchema(onboardingRequestSchema);
const PROFILE_RESPONSE_SCHEMA = toOpenApiSchema(profileResponseSchema);
const ERROR_RESPONSE = { schema: OBSERVATION_ERROR_RESPONSE_SCHEMA } as const;

/**
 * Onboarding and the profile it creates (P4.S1, SRS §3.0, Epic 7).
 *
 * Behind `JwtAuthGuard` like every patient route, and the subject comes from the
 * verified token — never from the body. There is no patient identifier anywhere
 * in this surface, in either direction, which is the same property
 * `GET /api/v1/observations` holds and for the same reason.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class OnboardingController {
  // Explicit `@Inject()`, not implicit type-based injection — see `AuditService`'s
  // constructor comment for why the latter resolves to `undefined` under this
  // workspace's Vitest (esbuild) transform.
  constructor(@Inject(OnboardingService) private readonly onboarding: OnboardingService) {}

  @Post('onboarding')
  // Route-level audit coverage (P1.S5). The service stages a *committed* entry —
  // the audit row is written inside provisioning's own transaction — so this
  // decorator is the trip-wire: an edit that drops the audit call fails the
  // request rather than silently creating a patient with no record of it.
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @UsePipes(new ZodBodyPipe(onboardingRequestSchema))
  @ApiOperation({
    summary: 'Create this patient and their profile',
    description:
      'The three fields SRS 3.0 makes mandatory before a patient can log anything: ostomy type, surgery date, measurement system. Each drives something that cannot be safely defaulted — expected-range selection, post-operative context, and every volume and weight display. Creates the patient row and the profile in ONE transaction, so a patient with no profile is not a reachable state. Answers 409 ALREADY_ONBOARDED for a subject that already has one: this endpoint means "I am new", and profile EDITS are a separate path (P4.S3). Rejects a surgery date in the future, which would make every entry the patient could make fail the Tier 1 bound this date becomes, and one implausibly far in the past, which would silently disable that bound for the life of the account.',
  })
  @ApiBody({ schema: ONBOARDING_REQUEST_SCHEMA })
  @ApiCreatedResponse({ schema: PROFILE_RESPONSE_SCHEMA })
  @ApiBadRequestResponse(ERROR_RESPONSE)
  @ApiConflictResponse(ERROR_RESPONSE)
  @ApiForbiddenResponse(ERROR_RESPONSE)
  async provision(
    @Req() request: Request,
    @Body() body: OnboardingRequest,
  ): Promise<ProfileResponse> {
    const actor = getPatientActor(request);
    const write = await this.onboarding.provision(actor, body, getRequestId(request));
    stageCommittedAuditEntry(
      request,
      {
        actorType: 'PATIENT',
        actorId: actor.id,
        action: 'CREATE',
        entityType: PROFILE_ENTITY_TYPE,
        entityId: write.profileId,
      },
      write.auditEventId,
    );
    return write.profile;
  }

  @Get('profile')
  @ApiOperation({
    summary: "Read the signed-in patient's profile",
    description:
      'How a client decides whether to show onboarding. Answers 403 PATIENT_NOT_PROVISIONED when there is no profile — the same code every write gives for the same state (#80), rather than a second vocabulary for it. A read, so no audit row (SRS 5.2), and it carries no patient identifier: the caller is the patient.',
  })
  @ApiOkResponse({ schema: PROFILE_RESPONSE_SCHEMA })
  @ApiForbiddenResponse(ERROR_RESPONSE)
  async profile(@Req() request: Request): Promise<ProfileResponse> {
    return this.onboarding.readProfile(getPatientActor(request));
  }
}
