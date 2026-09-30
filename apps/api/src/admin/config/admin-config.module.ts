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

import { AuditModule } from '../../audit/audit.module';
import { PrismaModule } from '../../prisma/prisma.module';
import { ThresholdsModule } from '../../thresholds/thresholds.module';
import { AdminAuthModule } from '../admin-auth.module';

import { AdminValueSetsController } from './admin-value-sets.controller';
import { AdminValueSetsService } from './admin-value-sets.service';

/**
 * The admin configuration API (P3.S3, ADR-0008).
 *
 * Imports `AdminAuthModule` and never `PatientAuthModule`. That is the boundary
 * SRS §4.6 puts at the identity layer: this module has no way to resolve the patient
 * guard, so no controller under it can be secured by the wrong one even by mistake.
 *
 * It imports `ThresholdsModule` for one reason only — to invalidate the read cache
 * after a write, so `GET /api/v1/value-sets` reflects an admin change on the next
 * fetch rather than up to five minutes later. It reads no patient data and must not
 * grow a dependency that can.
 */
@Module({
  imports: [PrismaModule, AuditModule, ThresholdsModule, AdminAuthModule],
  controllers: [AdminValueSetsController],
  providers: [AdminValueSetsService],
})
export class AdminConfigModule {}
