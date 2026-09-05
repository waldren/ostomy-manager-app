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
import { createRemoteJWKSet } from 'jose';

import { APP_CONFIG } from '../config/config.tokens';
import type { AppConfig } from '../config/env.schema';
import { AdminJwtAuthGuard } from './admin-jwt-auth.guard';
import { ADMIN_JWKS_RESOLVER } from './admin-jwks-resolver.token';
import { AdminStubController } from './admin-stub.controller';

@Module({
  controllers: [AdminStubController],
  providers: [
    AdminJwtAuthGuard,
    {
      provide: ADMIN_JWKS_RESOLVER,
      useFactory: (config: AppConfig) => createRemoteJWKSet(new URL(config.adminOidc.jwksUri)),
      inject: [APP_CONFIG],
    },
  ],
  exports: [AdminJwtAuthGuard],
})
export class AdminAuthModule {}
