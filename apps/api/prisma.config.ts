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

// CLI-time configuration for `prisma migrate`, `prisma generate`, etc.
// Prisma ORM 7 moved the datasource connection string out of
// schema.prisma's `datasource` block and into this file (see
// prisma/schema.prisma's datasource comment) — this file is read by the
// `prisma` CLI only. It has no bearing on how the running API connects at
// runtime; that is `src/prisma/prisma.service.ts`, which builds its own
// `@prisma/adapter-pg` adapter directly from `DATABASE_URL` and never loads
// this file.
//
// `import 'dotenv/config'` is for local, outside-Docker CLI use (e.g.
// `pnpm --filter @ostomy/api exec prisma migrate dev` against a
// developer's own Postgres) — it is a no-op, not a throw, when no `.env`
// file exists, which is the normal case inside a container: the `migrate`
// service in infra/docker-compose.yml sets DATABASE_URL as a real
// environment variable and never mounts a `.env` file (see
// infra/docker/api.Dockerfile's "No .env file" comment).
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // The OWNER role's DSN (ADR-0011) — `migrate`/CI/Testcontainers only.
    // The runtime role never runs a CLI command against this config.
    //
    // Deliberately `process.env.DATABASE_URL` here, not prisma/config's own
    // `env()` helper: `env()` throws immediately if the variable is unset,
    // and `prisma generate` (unlike `migrate`) never connects to a
    // database — it only reads schema.prisma. `apps/api`'s `build` script
    // runs `prisma generate` and the Docker build stage that runs it has
    // no DATABASE_URL at all (that is only ever set on the `migrate`/`api`
    // Compose services, not at image-build time — see
    // infra/docker/api.Dockerfile's "build" stage). Requiring it there
    // would fail the image build for a command that does not need it. A
    // `migrate`/`db` command that genuinely needs a connection still fails
    // loudly — just from Postgres ("password authentication failed" /
    // connection refused) rather than from this file, once it tries to
    // actually connect with an empty string.
    url: process.env.DATABASE_URL ?? '',
  },
});
