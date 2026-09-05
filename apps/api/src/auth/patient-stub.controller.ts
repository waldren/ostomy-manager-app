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

import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { getPatientActor } from './patient-actor';
import { JwtAuthGuard } from './jwt-auth.guard';

/**
 * Proves the patient auth boundary end to end. No business logic — this
 * route and its guard are replaced by the first real patient-scoped endpoint
 * at P2.S1a, not extended in place.
 *
 * Convention for every controller added under `src/auth/**` from here on:
 * apply `JwtAuthGuard` at the controller (class) level, never rely on a
 * global guard, and never on a per-method basis on a controller that mixes
 * guarded and unguarded routes — matches the admin surface's convention in
 * `admin-stub.controller.ts`, so the two directories diff cleanly.
 */
@ApiTags('auth')
@Controller('auth-stub')
@UseGuards(JwtAuthGuard)
export class PatientStubController {
  @Get()
  @ApiBearerAuth('patient-oidc')
  @ApiOperation({ summary: 'Returns the authenticated patient subject. Stub only.' })
  get(@Req() request: Request): { patientId: string } {
    return { patientId: getPatientActor(request).id };
  }
}
