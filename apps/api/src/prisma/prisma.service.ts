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
    //
    // Deliberately NOT calling `assertRuntimeRoleIsNotOverPrivileged()`
    // here (B4, P1.S3 review response) — see that method's own doc comment
    // for what it does and why. Calling it from this hook would reintroduce
    // exactly the eager-database-dependency problem the class doc comment
    // above explains `$connect()` was kept out of: every test that boots
    // `AppModule` would need a live, reachable Postgres just to construct
    // the module graph, the same class of problem whether the eager call is
    // `$connect()` or a query. Whichever future sprint imports
    // `PrismaModule` into `AppModule` (P1.S5's audit/threshold module, or
    // P2.S1a's observations module — see `PrismaModule`'s own comment) is
    // responsible for calling `assertRuntimeRoleIsNotOverPrivileged()`
    // explicitly and deliberately in `main.ts`'s bootstrap sequence, once
    // there is a real connection to check and a real reason for every boot
    // to need one.
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Boot-time privilege self-check (B4, P1.S3 review response).
   *
   * Asserts a PROPERTY of the connected role, not its NAME: `SELECT
   * has_table_privilege('audit_events', 'UPDATE') OR
   * has_table_privilege('audit_events', 'DELETE') OR
   * has_table_privilege('audit_events', 'TRUNCATE')` is true only for a role
   * that could defeat ADR-0011's audit-immutability guarantee. This is
   * deliberately different from — and a strictly stronger check than —
   * asserting the connected role's name is `'ostomy_runtime'`: a name check
   * would pass for a role called `ostomy_runtime` that had somehow been
   * granted `UPDATE`/`DELETE`/`TRUNCATE` (a future over-granting migration),
   * or that had somehow become a superuser (B3's exact failure mode, which
   * bypasses privilege checks including `has_table_privilege` itself —
   * `false` is never returned to a superuser querying its own privileges, so
   * this check also catches B3's failure mode as a side effect). It equally
   * catches a wrong DSN pointing at the owner role, or a forgotten
   * post-deploy `ALTER ROLE`, in every environment this ever runs in —
   * including production, none of which the Testcontainers-based
   * integration test (`prisma.integration.spec.ts`) exercises, since that
   * test constructs its own ephemeral database and role from scratch every
   * run.
   *
   * `TRUNCATE` (S7, P1.S5 review response): `UPDATE`/`DELETE` alone missed a
   * role granted `TRUNCATE ON audit_events` by a future over-granting
   * migration — `TRUNCATE` empties the table in one statement, no `WHERE`
   * clause, no per-row trigger, wiping the append-only store just as
   * completely as an unrestricted `DELETE` would.
   *
   * Throws rather than returning a boolean: a positive result here means
   * the running process can silently defeat SRS §5.2's append-only audit
   * requirement, which must fail the boot, not be logged and continued
   * past.
   *
   * Not called from `onModuleInit` — see that method's comment for why.
   */
  async assertRuntimeRoleIsNotOverPrivileged(): Promise<void> {
    const rows = await this.$queryRaw<Array<{ over_privileged: boolean }>>`
      SELECT
        has_table_privilege('audit_events', 'UPDATE')
        OR has_table_privilege('audit_events', 'DELETE')
        OR has_table_privilege('audit_events', 'TRUNCATE') AS over_privileged
    `;
    if (rows[0]?.over_privileged) {
      throw new Error(
        'Refusing to start: the connected database role can UPDATE or DELETE audit_events ' +
          '(or TRUNCATE it). This defeats the append-only audit guarantee ADR-0011 requires ' +
          "(SRS §5.2). Check DATABASE_URL is the runtime role's DSN, not the owner/migration " +
          "role's, and that no migration has over-granted the runtime role.",
      );
    }
  }
}
