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

import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

interface HealthResponse {
  status: 'ok';
  timestamp: string;
}

/**
 * Unauthenticated liveness check.
 *
 * Deliberately reports nothing beyond "the process is accepting requests".
 * There is no database, no object storage, and no OIDC provider dependency
 * in this sprint (P1.S1) — claiming readiness for any of those would be
 * dishonest. Add a separate `/health/ready` endpoint once P1.S2/P1.S3 give
 * this process dependencies actually worth checking; do not expand this one
 * to guess at them.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Liveness check. Always unauthenticated.' })
  check(): HealthResponse {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
