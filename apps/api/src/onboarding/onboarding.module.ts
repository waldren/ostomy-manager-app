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

import { OnboardingController } from './onboarding.controller';
import { OnboardingService } from './onboarding.service';

/**
 * Provisioning and the profile (P4.S1, SRS 3.0).
 *
 * `AuditModule` is imported directly rather than relied on transitively, for
 * the reason `ObservationsModule` gives: this service calls
 * `AuditService.record()` itself, inside its own transaction, rather than
 * leaving the audit row to the global interceptor.
 * `AuditInterceptorModule` still enforces route-level coverage.
 */
@Module({
  imports: [PatientAuthModule, PrismaModule, AuditModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
})
export class OnboardingModule {}
