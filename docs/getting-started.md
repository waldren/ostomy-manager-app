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

All three clients that exist are listed below. There is still no `apps/admin`.

- **API, standalone (no Docker):** `cp apps/api/.env.example apps/api/.env`, fill in real values, then
  `pnpm --filter @ostomy/api start:dev`. It needs a reachable PostgreSQL (P1.S3 onward) — point
  `DATABASE_URL` at the Docker stack's database, or bring up the whole stack below. Serves
  `POST`/`GET /api/v1/observations` (P2.S1a), `POST /api/v1/sync/push` and `GET /api/v1/sync/delta`
  (P2.S1b — see `docs/sync-contract.md`, which governs that surface), and Swagger UI at `/api-docs`
  outside production.
  `pnpm --filter @ostomy/api openapi:generate` writes `openapi.json` without a server or a database;
  `api-client:generate` then regenerates `packages/core/src/api-client`, which is never hand-edited.
  See `apps/api/README.md`.
- **Web (`apps/web`), P2.S3:** `cp apps/web/.env.example apps/web/.env.local`, then
  `pnpm --filter @ostomy/web dev` (http://localhost:5173). Online-only by explicit decision — it
  never speaks the sync protocol and has no local persistence. `VITE_OIDC_AUDIENCE` must equal the
  API's `OIDC_AUDIENCE`, or sign-in succeeds and every API call then returns 401.
  `build | typecheck | test | lint` on the same filter.
- **Shared UI (`packages/ui`), P2.S3:** `pnpm --filter @ostomy/ui build | typecheck | test | lint`.
  `build:deps` builds it, so a clean clone gets a real `dist` before anything imports it.
- **Mobile (`apps/mobile`), P2.S2a:** `cp apps/mobile/.env.example apps/mobile/.env`, then
  `pnpm --filter @ostomy/mobile start` (`ios` / `android` to open a simulator directly). Set
  `EXPO_PUBLIC_API_URL` to the development server's LAN address; the test device must be on the same
  network. `typecheck | test | test:watch` on the same filter — the suite runs against Node's
  built-in SQLite rather than a simulator, so `test` needs no device.

  Its device-side security controls (SQLCipher, keychain accessibility, biometric enrolment
  invalidation) **cannot be exercised by `pnpm test`** — jest runs no keychain. They need real iOS
  and Android hardware; see ADR-0014 and ADR-0015.
- **Android emulator (`apps/mobile`):** `scripts/android-emulator.sh` manages a Pixel 8 AVD for
  on-device testing, wired to the Compose stack. `doctor` first — the emulator and the development
  build have separate prerequisites, and it names which one you are missing.

  ```bash
  scripts/android-emulator.sh doctor      # or: pnpm --filter @ostomy/mobile emulator:doctor
  scripts/android-emulator.sh up          # create + boot + adb reverse (idempotent)
  pnpm --filter @ostomy/mobile android    # expo run:android — the development build
  ```

  Build the app with a **JDK between 17 and 21**. Android Studio bundles JDK 25, which AGP 8.12
  (React Native 0.86's pin) cannot drive CMake on — every native module fails at configure time
  with a `restricted method in java.lang.System` error that names neither the JDK nor the cause.
  `doctor` locates a usable JDK (Gradle usually has one at `~/.gradle/jdks/`) and prints the
  `export JAVA_HOME=...` line. `expo prebuild` generates `apps/mobile/android/` as build output:
  gitignored, and ignored by Prettier and ESLint, which walk the filesystem rather than git.

  SQLCipher is a config-plugin native change, so **Expo Go cannot run this app** — it needs a
  development build. Networking is `adb reverse`, never `10.0.2.2`: `mock-oidc` derives its
  advertised `issuer` from the request's Host header, so a device reaching it as `10.0.2.2` gets
  tokens whose `iss` the API rejects, after a sign-in that appeared to succeed. Note also that
  Metro's default port 8081 is already published by the `admin` container — start Metro on 8082.

  An emulator exercises the *logic* of ADR-0014/ADR-0015 (it reports fingerprint and a
  hardware keystore, but no StrongBox — KeyMint in software). It does not discharge the
  "verified on hardware" caveat above.
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
