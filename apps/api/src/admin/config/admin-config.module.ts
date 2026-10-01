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
 *
 * ## Why that import does not leak the patient guard, and what does carry reach
 *
 * `ThresholdsModule` imports `PatientAuthModule` (its own controllers are
 * patient-guarded) but exports only `ThresholdsService`, and `PatientAuthModule` is
 * not `@Global()`. NestJS encapsulation therefore means `JwtAuthGuard` is **not
 * resolvable from here** — a `@UseGuards(JwtAuthGuard)` on an admin controller fails
 * at `app.init()` rather than shipping. Do not "tidy" that by re-exporting it. Both
 * reviews of PR A disagreed about this; it was settled by reading the exports.
 *
 * What does carry reach is `PrismaModule`: `AdminValueSetsService` holds a full
 * `PrismaService`, so `this.prisma.observation.findMany()` would compile and lint
 * clean. The admin import-boundary lint rule matches `@ostomy/*` specifier strings
 * and documents relative traversal as out of scope, so it cannot see that either. The
 * load-bearing control is `route-guard-coverage.spec.ts`, which boots the real module
 * graph; the durable fix is the `no-restricted-paths` rule that rule's comment defers
 * to P8.S1, and it should cover `apps/api/src/admin/**` when it lands.
 *
 * One honest limit on the invalidation: `ThresholdsService`'s cache is per-process,
 * not cluster-wide. On multi-task Fargate a retirement stays offerable to patients on
 * other processes until their own TTL expires. No past entry changes meaning, so this
 * is not a §3.11 problem, but it is the case where staleness is most visible — see
 * that service's class comment, which records the two ways out.
 */
@Module({
  imports: [PrismaModule, AuditModule, ThresholdsModule, AdminAuthModule],
  controllers: [AdminValueSetsController],
  providers: [AdminValueSetsService],
})
export class AdminConfigModule {}
