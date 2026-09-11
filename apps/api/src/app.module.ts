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

import { Module, type DynamicModule } from '@nestjs/common';

import { AdminAuthModule } from './admin/admin-auth.module';
import { AuditInterceptorModule } from './audit/audit-interceptor.module';
import { AuditStubModule } from './audit/test-support/audit-stub.module';
import { PatientAuthModule } from './auth/patient-auth.module';
import { ConfigModule } from './config/config.module';
import type { AppConfig } from './config/env.schema';
import { ErrorSanitizerModule } from './http/error-sanitizer.module';
import { HealthModule } from './health/health.module';
import { LoggingModule } from './logging/logging.module';
import { ObservationsModule } from './observations/observations.module';
import { PrismaModule } from './prisma/prisma.module';
import { ThresholdsModule } from './thresholds/thresholds.module';

@Module({})
export class AppModule {
  /**
   * Takes the already-validated `AppConfig` as a value — see
   * `config/config.module.ts` for why config loading happens in `main.ts`
   * rather than inside this module graph.
   *
   * `PrismaModule` (./prisma/prisma.module.ts) enters this graph here, at
   * P1.S5 — P1.S3's own comment on that module named this sprint as the one
   * responsible for it, because this is the first sprint with a real
   * consumer (`AuditModule`/`ThresholdsModule`, both imported transitively
   * below). `PrismaService` still connects lazily (see its own doc
   * comment), so no test that only calls `app.init()` — `app.module.spec.ts`,
   * `route-guard-coverage.spec.ts` — newly needs a live Postgres just to
   * construct the module graph; `main.ts`'s bootstrap is the one place that
   * now does, via `assertRuntimeRoleIsNotOverPrivileged()` (ADR-0011, B4).
   *
   * `AuditInterceptorModule` (not just `AuditModule`) is what actually
   * registers the global `APP_INTERCEPTOR` — see that module's own comment
   * for why the two are split. `AuditStubModule` is TEST SCAFFOLDING (see
   * its controller's doc comment): it exists only so the audit interceptor,
   * `route-guard-coverage.spec.ts`, and `app-http-surface.spec.ts` have a
   * real `@Audited()` route to exercise before P2.S1a's first genuine PHI
   * endpoint lands. Remove it (and this conditional) in the same change
   * that adds that endpoint.
   *
   * B4 (P1.S5 review response): `AuditStubModule` is gated out of any
   * `production`-config graph, not merely commented as test-only.
   * `tsconfig.build.json` excludes `src/**\/*.spec.ts` and
   * `src/test-support/**`, but the stub lives at
   * `src/audit/test-support/**`, which that glob does not match, and this
   * module imported it unconditionally — so it shipped in every build
   * regardless of environment. In a deployed environment that meant any
   * authenticated patient could `POST /api/v1/audit-stub/widgets` with an
   * arbitrary body, copied verbatim into `afterValue` and persisted into
   * `audit_events`, the one table with no `DELETE` grant: unbounded
   * attacker-controlled JSON with no application-level cleanup path, on top
   * of an unbounded in-memory `Map`. `app.module.spec.ts`'s "excludes
   * AuditStubModule from a production-config graph" test asserts this gate
   * holds — a comment alone is exactly as forgettable as the one this
   * replaces.
   */
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.register(config),
        LoggingModule,
        HealthModule,
        PatientAuthModule,
        AdminAuthModule,
        PrismaModule,
        ErrorSanitizerModule,
        AuditInterceptorModule,
        ...(config.nodeEnv !== 'production' ? [AuditStubModule] : []),
        ThresholdsModule,
        ObservationsModule,
      ],
    };
  }
}
