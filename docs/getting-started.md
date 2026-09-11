# Getting Started

Local setup and prerequisites for working on the ostomy patient management app.

## Prerequisites

- **Node.js** — version pinned in `.nvmrc` (currently 24.x). `nvm use` picks it up.
- **pnpm** — version pinned by the `packageManager` field in the root `package.json`. With Corepack: `corepack enable`.
- **Docker with the Compose plugin** — required for API integration tests (Testcontainers), and for running the stack locally rather than against the shared development server.
- **Expo CLI** — for `apps/mobile`, once it is scaffolded.

## Setup

```bash
pnpm install
```

## Repo layout

A pnpm-workspace monorepo (`apps/*` for mobile, web, API and the admin console; `packages/*` for shared code). See the root `README.md` for the full layout and `docs/architecture.md` for how the pieces fit together.

`packages/config` holds the shared TypeScript, ESLint and Prettier configuration that every other workspace extends. There is deliberately **no task runner** — plain pnpm scripts only, see [ADR-0003](../design-specs/decisions/0003-monorepo-task-tooling.md).

## Everyday commands

Run from the repo root. All of them recurse across workspaces.

```bash
pnpm lint            # ESLint across the monorepo
pnpm lint:fix        # ...and autofix (inserts missing AGPL headers)
pnpm typecheck       # tsc --noEmit per workspace
pnpm test            # full test suite
pnpm test:unit       # excludes Testcontainers-backed integration tests
pnpm format          # Prettier check
pnpm format:write    # ...and rewrite
pnpm check:env       # fails if a .env is tracked by git
pnpm verify          # everything CI runs, in the same order
```

`pnpm verify` is the one to run before opening a PR.

Scoped to a single workspace:

```bash
pnpm --filter @ostomy/config test
```

### Three lint rules that will stop you

These fail the build rather than warn, each because a project constraint depends on them:

| Rule                        | Fires when                                                       | Fix                                                                                                                                   |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ostomy/agpl-header`        | A source file under `apps/` or `packages/` lacks the AGPL header | `pnpm lint:fix` inserts it                                                                                                            |
| `no-restricted-imports`     | `apps/admin` imports a patient-scoped module                     | Don't. The admin console has zero PHI access ([ADR-0008](../design-specs/decisions/0008-admin-config-api-before-console.md))          |
| `i18next/no-literal-string` | A hardcoded user-facing string in UI code                        | Move it to the shared catalog in `packages/core/i18n` ([ADR-0006](../design-specs/decisions/0006-i18n-library-and-shared-catalog.md)) |

## Running the apps

`apps/web` and `apps/mobile` currently hold README stubs, and there is no `apps/admin`.

- **API, standalone (no Docker):** `cp apps/api/.env.example apps/api/.env`, fill in real values, then
  `pnpm --filter @ostomy/api start:dev`. It needs a reachable PostgreSQL (P1.S3 onward) — point
  `DATABASE_URL` at the Docker stack's database, or bring up the whole stack below. Serves
  `POST`/`GET /api/v1/observations` (P2.S1a) and Swagger UI at `/api-docs` outside production.
  `pnpm --filter @ostomy/api openapi:generate` writes `openapi.json` without a server or a database;
  `api-client:generate` then regenerates `packages/core/src/api-client`, which is never hand-edited.
  See `apps/api/README.md`.
- Web: `TBD` — lands with P2.S3
- Mobile (Expo): `TBD` — lands with P2.S2a. Set `EXPO_PUBLIC_API_URL` to the development server's LAN address; the test device must be on the same network
- **Local Docker stack:** scaffolded at P1.S2. From the repo root:

  ```bash
  cp .env.example .env    # then fill in real (still synthetic-only) values — every required
                          # value uses Compose's ${VAR:?...} syntax, so a value left unset fails
                          # loudly at the next command rather than deploying with an empty one
  docker compose --env-file .env -f infra/docker-compose.yml up -d --build
  curl http://localhost:3000/api/v1/health
  ```

  Brings up `postgres`, `db-roles` (one-shot; applies the migration-owner/runtime-role split —
  see `infra/db/README.md`), `minio`, `mock-oidc`, a one-shot `migrate` (applies the Prisma
  migrations as the owner role — P1.S3 onward), `api`, and static placeholder
  `web`/`admin` containers — see `docs/deployment-development.md` for the full topology and
  `infra/docker-compose.yml` for the wiring. `.env.example`'s `DEV_HOST_ADDRESS` comment explains
  a real dev-host gotcha specific to the mock OIDC provider — there is no default that "just
  works" even on your own machine; set it explicitly (`localhost` is fine for genuinely
  single-machine use, but is never the right value on the shared host — read the comment before
  choosing it there). `DEV_BIND_ADDRESS` similarly has no LAN-reachable default (`127.0.0.1`);
  set it to the host's LAN address only on the shared host.

  Reset (wipes `pgdata`/`miniodata`, recreates, migrates — nothing else may destroy data):

  ```bash
  scripts/dev-reset.sh   # or: pnpm dev:reset (works from a Windows checkout too)
  ```

  On the shared dev host this stack is deployed by `.github/workflows/deploy-dev.yml` on every
  push to `main` — see `docs/git-workflow.md` ("`main` is deployed on every merge").

See `design-specs/planning/v1-implementation-plan.md` for the sequence.

## Before you write code

Read `CLAUDE.md`, then the ADRs in `design-specs/decisions/`. [ADR-0001](../design-specs/decisions/0001-sync-contract-and-conflict-semantics.md) (sync contract) and [ADR-0007](../design-specs/decisions/0007-packages-core-ownership.md) (`packages/core` ownership) bind almost every change. `docs/git-workflow.md` covers branching and PRs; `docs/testing.md` covers test conventions.

## Shared development environment

A single shared, fully containerized stack runs on an on-premise server — API, PostgreSQL, MinIO, a mock OIDC provider, and both SPAs — reachable over the LAN. It holds synthetic data only and is safe to reset at any time. See `deployment-development.md` for how it is built, deployed, and reseeded.
