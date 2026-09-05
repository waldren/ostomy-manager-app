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

import { getAdminActor } from './admin-actor';
import { AdminJwtAuthGuard } from './admin-jwt-auth.guard';

/**
 * Proves the admin auth boundary end to end, on the isolated `/api/v1/admin/...`
 * surface (SRS_v2 §3.11, §4.6). No business logic — the real admin config API
 * lands at P3.S3 (ADR-0008), at this same guard's final shape.
 *
 * Convention for every controller added under `src/admin/**` from here on:
 * apply `AdminJwtAuthGuard` at the controller (class) level, never rely on a
 * global guard. Keeping the guard visible on each admin controller is what
 * keeps the boundary auditable file-by-file as the admin surface grows.
 */
@ApiTags('admin-auth')
@Controller('admin/auth-stub')
@UseGuards(AdminJwtAuthGuard)
export class AdminStubController {
  @Get()
  @ApiBearerAuth('admin-oidc')
  @ApiOperation({ summary: 'Returns the authenticated admin subject. Stub only.' })
  get(@Req() request: Request): { adminId: string } {
    return { adminId: getAdminActor(request).id };
  }
}
