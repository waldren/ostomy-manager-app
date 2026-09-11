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
import { SyncController } from './sync.controller';
import { SyncDeltaService } from './sync-delta.service';
import { SyncPushService } from './sync-push.service';

/**
 * `AuditModule` is imported directly, as in `ObservationsModule` and for a
 * sharper version of the same reason: this module's push service writes one
 * audit row per applied operation inside that operation's own transaction.
 * The global interceptor cannot do that — it covers routes, and a push batch
 * applying fifty operations is one route (docs/sync-contract.md §4.1).
 */
@Module({
  imports: [PatientAuthModule, PrismaModule, ThresholdsModule, AuditModule],
  controllers: [SyncController],
  providers: [SyncPushService, SyncDeltaService],
})
export class SyncModule {}
