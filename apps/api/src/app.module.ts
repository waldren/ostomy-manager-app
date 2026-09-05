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
import { PatientAuthModule } from './auth/patient-auth.module';
import { ConfigModule } from './config/config.module';
import type { AppConfig } from './config/env.schema';
import { HealthModule } from './health/health.module';
import { LoggingModule } from './logging/logging.module';

@Module({})
export class AppModule {
  /**
   * Takes the already-validated `AppConfig` as a value — see
   * `config/config.module.ts` for why config loading happens in `main.ts`
   * rather than inside this module graph.
   *
   * `PrismaModule` (../prisma/prisma.module.ts) is deliberately NOT
   * imported here yet (P1.S3). This sprint proves the migration and the
   * connection work via that module's own integration test; nothing in
   * this application actually reads or writes the database yet. Importing
   * it here now would give every test that boots `AppModule` — including
   * `app.module.spec.ts`, which supplies a synthetic `databaseUrl` no
   * container is listening on — a live-database dependency it does not
   * need. Add the import in the same change that adds the first consumer
   * (P1.S5's audit/threshold module, or P2.S1a's observations module).
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
      ],
    };
  }
}
