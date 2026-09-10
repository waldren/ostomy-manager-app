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

import { AuditModule } from '../audit/audit.module';
import { PatientAuthModule } from '../auth/patient-auth.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ThresholdsModule } from '../thresholds/thresholds.module';
import { ObservationsController } from './observations.controller';
import { ObservationsService } from './observations.service';

/**
 * `AuditModule` is imported directly rather than relied on transitively: this
 * module's service calls `AuditService.record()` itself, inside its own
 * transaction, rather than leaving every audit row to the global
 * interceptor. `AuditInterceptorModule` (registered in `AppModule`) is still
 * what enforces route-level coverage.
 */
@Module({
  imports: [PatientAuthModule, PrismaModule, ThresholdsModule, AuditModule],
  controllers: [ObservationsController],
  providers: [ObservationsService],
})
export class ObservationsModule {}
