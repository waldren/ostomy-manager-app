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

import { SecurityLogService } from './security-log.service';

/**
 * Its own module rather than a provider on `LoggingModule`, deliberately.
 *
 * `LoggingModule` configures the Pino request pipeline, and integration
 * suites override it wholesale to capture output
 * (`observations.integration.spec.ts`'s `CapturingLoggingModule`). Anything
 * added to it is therefore invisible to those tests — which is how the first
 * version of this failed: `SyncModule` imported `LoggingModule` for
 * `SecurityLogService`, and every observations integration test died with
 * "Nest can't resolve dependencies of the SyncPushService".
 *
 * `SecurityLogService` has no dependency on the Pino wiring at all — it uses
 * Nest's own `Logger` — so it has no business living behind a module that
 * exists to configure Pino and gets replaced in tests.
 */
@Module({
  providers: [SecurityLogService],
  exports: [SecurityLogService],
})
export class SecurityLogModule {}
