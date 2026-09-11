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
import { APP_FILTER } from '@nestjs/core';

import { ErrorSanitizerFilter } from './error-sanitizer.filter';

/**
 * Registers `ErrorSanitizerFilter` globally.
 *
 * `APP_FILTER` from a module, not `useGlobalFilters()` in `main.ts`, for the
 * same reason `AuditInterceptorModule` uses `APP_INTERCEPTOR`: anything wired
 * only in `main.ts` is absent from every `Test.createTestingModule()` graph,
 * so its tests would be exercising a different application than the one that
 * ships. This filter in particular is only reachable for body-parser errors
 * when it is global, so a test that could not see it would have been unable
 * to prove the one thing it exists for.
 */
@Module({
  providers: [{ provide: APP_FILTER, useClass: ErrorSanitizerFilter }],
})
export class ErrorSanitizerModule {}
