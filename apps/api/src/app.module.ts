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
