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

import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { AuditService } from './audit.service';

/**
 * The audit domain module: `AuditService` only. Deliberately does NOT
 * register `AuditInterceptor` as a global `APP_INTERCEPTOR` — that
 * registration lives in the separate `AuditInterceptorModule`
 * (`audit-interceptor.module.ts`) so this module stays usable on its own
 * wherever a write path needs `AuditService` directly (a future sync
 * conflict-loser handler, P2.S1b) without also pulling in the global
 * enhancer registration.
 *
 * This split is also what lets `audit.integration.spec.ts` build a
 * deliberately-unaudited variant of the same routes for the sprint's central
 * proof (AC1): import `AuditModule` for the service, but omit
 * `AuditInterceptorModule`, and the exact same write succeeds with no audit
 * row.
 */
@Module({
  imports: [PrismaModule],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
