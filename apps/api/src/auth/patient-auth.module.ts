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
  // Both are exported, not just `JwtAuthGuard` alone: a module that only
  // IMPORTS `PatientAuthModule` (rather than declaring the controller here
  // directly, as `PatientStubController` above does) and applies
  // `@UseGuards(JwtAuthGuard)` to its own controller needs
  // `PATIENT_JWKS_RESOLVER` to also resolve from ITS OWN module scope —
  // verified empirically: `@nestjs/testing`'s `TestingInjector` does not
  // walk into `JwtAuthGuard`'s already-exported-and-instantiated
  // dependencies for a guard referenced this way from a second module;
  // it re-resolves the guard's constructor params from the consuming
  // module's own visible providers. `P2.S1a`'s first real observations
  // module hits this exact shape (its own module, `@UseGuards(JwtAuthGuard)`,
  // importing `PatientAuthModule` rather than living inside it) — exporting
  // the resolver token here is what makes that work rather than reproducing
  // this sprint's own audit-stub-module debugging session.
  exports: [JwtAuthGuard, PATIENT_JWKS_RESOLVER],
})
export class PatientAuthModule {}
