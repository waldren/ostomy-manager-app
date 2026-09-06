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
import { APP_INTERCEPTOR } from '@nestjs/core';

import { AuditModule } from './audit.module';
import { AuditInterceptor } from './audit.interceptor';

/**
 * The global registration, kept separate from `AuditModule` itself — see
 * that module's doc comment for why. `AppModule` imports this module (not
 * just `AuditModule`) to actually get audit coverage on every request; a
 * test that wants to demonstrate what happens *without* the interceptor
 * imports `AuditModule` alone.
 */
@Module({
  imports: [AuditModule],
  providers: [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }],
})
export class AuditInterceptorModule {}
