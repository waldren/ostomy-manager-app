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
import { JwtAuthGuard } from './jwt-auth.guard';
import { PATIENT_JWKS_RESOLVER } from './patient-jwks-resolver.token';
import { PatientStubController } from './patient-stub.controller';

@Module({
  controllers: [PatientStubController],
  providers: [
    JwtAuthGuard,
    {
      // `jose.createRemoteJWKSet` does its own bounded-frequency caching and
      // refetching — "sane refresh" without this guard implementing caching
      // itself. Tests construct `JwtAuthGuard` directly with a local,
      // in-memory JWKS instead of going through this provider.
      provide: PATIENT_JWKS_RESOLVER,
      useFactory: (config: AppConfig) => createRemoteJWKSet(new URL(config.oidc.jwksUri)),
      inject: [APP_CONFIG],
    },
  ],
  exports: [JwtAuthGuard],
})
export class PatientAuthModule {}
