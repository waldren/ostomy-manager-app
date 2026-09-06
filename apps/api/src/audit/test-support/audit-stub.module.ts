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

import { PatientAuthModule } from '../../auth/patient-auth.module';
import { AuditStubController } from './audit-stub.controller';

/**
 * TEST SCAFFOLDING — see `audit-stub.controller.ts`'s own doc comment.
 * Imports `PatientAuthModule` only for `JwtAuthGuard`'s DI dependencies
 * (`APP_CONFIG`, `PATIENT_JWKS_RESOLVER`); it does not need `AuditModule` or
 * `AuditInterceptorModule` itself — the controller only calls the plain
 * `stageAuditEntry()` function, never `AuditService` directly, so this
 * module can be composed with or without the interceptor registration by
 * whatever imports it (see `audit.integration.spec.ts`).
 */
@Module({
  imports: [PatientAuthModule],
  controllers: [AuditStubController],
})
export class AuditStubModule {}
