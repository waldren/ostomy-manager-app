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

import { Global, Module, type DynamicModule } from '@nestjs/common';

import { APP_CONFIG } from './config.tokens';
import type { AppConfig } from './env.schema';

/**
 * Global module exposing an already-validated `AppConfig` under the
 * `APP_CONFIG` token.
 *
 * `register()` takes the config as a value rather than loading and
 * validating it itself, so `main.ts` calls `loadConfig()` — and can fail
 * loudly on a missing or malformed variable — *before* `NestFactory.create`
 * runs at all. That keeps "fail fast at startup" independent of how Nest
 * happens to handle an exception thrown inside a factory provider, and gives
 * `main.ts` a single, controlled place to format the fatal message.
 */
@Global()
@Module({})
export class ConfigModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
