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

import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';

import { APP_CONFIG } from '../config/config.tokens';
import type { AppConfig } from '../config/env.schema';
import { PrismaClient } from '../generated/prisma/client';

/**
 * The one place `apps/api` constructs a database connection.
 *
 * P1.S3 scope, deliberately narrow: this proves the migration and the
 * connection work end to end (via the integration test alongside this
 * file) and gives P1.S5's `AuditInterceptor`/`ThresholdsService` and
 * P2.S1a's observation endpoints something to inject. It is NOT wired into
 * `AppModule` by this sprint — see that file's comment for why — so
 * importing `PrismaModule` is the first thing whichever of those lands
 * next needs to do, not this one.
 *
 * Always connects with the RUNTIME role's DSN (`AppConfig.databaseUrl`,
 * sourced from `DATABASE_URL` — ADR-0011). Nothing in this class, or
 * anywhere else in application code, is ever given the migration/owner
 * role's DSN; that DSN is a CLI-time-only concern
 * (`apps/api/prisma.config.ts`, the `migrate` Compose service).
 *
 * Prisma ORM 7's "Rust-free" client has no bundled query-engine binary; it
 * delegates SQL execution to a driver adapter (`@prisma/adapter-pg`
 * wrapping `pg`, constructed here from the same `databaseUrl` the rest of
 * `AppConfig` is validated from at boot — see `config/load-config.ts`).
 *
 * Deliberately does NOT call `this.$connect()` in `onModuleInit`: Prisma
 * connects lazily on first query either way, and an eager `$connect()`
 * here would make every test that boots `AppModule` (e.g.
 * `app.module.spec.ts`, which supplies a synthetic, unreachable
 * `databaseUrl`) require a live Postgres just to construct the module
 * graph. `onModuleDestroy` still explicitly `$disconnect()`s, so a real
 * connection — once one exists — is not leaked past the module's
 * lifecycle.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({ adapter: new PrismaPg({ connectionString: config.databaseUrl }) });
  }

  onModuleInit(): void {
    // No $connect() call — see the class doc comment above for why.
    // Logged at debug, never with the DSN (which carries the runtime
    // role's password): docs/security-hipaa.md "Never log PHI" extends to
    // never logging credentials either, and `config.databaseUrl` is never
    // interpolated into a log line anywhere in this file.
    this.logger.debug('PrismaService constructed; connection is lazy (first query).');
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
