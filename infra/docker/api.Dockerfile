# syntax=docker/dockerfile:1
#
# Multi-stage build for @ostomy/api, per docs/deployment-development.md
# "Image build". Build context is the repo root (see infra/docker-compose.yml
# `build.context: ..`) because a pnpm workspace install needs the root
# manifest, the lockfile, and every workspace's own package.json.
#
# Stages: base -> deps -> build -> {prod-deps -> runtime, migrate-deps ->
# migrate}. `runtime` and `migrate` are two separate, divergent leaves built
# from the same `build` stage, not a linear chain — see each one's own
# comment below for why they need different node_modules.
#
# Both infra/docker-compose.yml services now pass `build.target` explicitly
# (`runtime` for `api`, `migrate` for `migrate`) rather than relying on
# "whichever stage is physically last in this file" — that implicit-default
# behavior is exactly what this stage split turned into a footgun: a second
# leaf stage added after `runtime` would have silently become the new
# default for anything that omitted `target`. `runtime` is still kept last
# below anyway, as defense in depth for a bare `docker build` with no
# `--target`, but nothing here depends on that anymore.
#
# `apps/api` is a CommonJS build (ADR-0010): this Dockerfile runs the built
# `dist/main.js` output with plain `node`, never `tsx`. If the built image
# fails to start with ERR_REQUIRE_ASYNC_MODULE or a module-resolution error,
# that is a real ADR-0010 finding (a `require(esm)` failure vitest's ESM
# transform cannot see) — do not "fix" it by switching this image to `tsx`.

# Kept in step with .nvmrc (currently 24.14.0) by hand — nothing enforces
# this automatically, so bumping one without checking the other is a real
# way for the image's Node version and the version every other workspace
# command runs against to quietly drift apart.
ARG NODE_IMAGE=node:24.14.0-slim
ARG PNPM_VERSION=10.34.5

# --- base --------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /workspace

# --- deps ----------------------------------------------------------------
# Only manifests, so this layer (and its `pnpm install`) is cached until the
# lockfile or a workspace's package.json actually changes — source changes
# below never bust it.
#
# Every workspace with a package.json must be listed here explicitly (a
# workspace with only a README stub has none yet and is intentionally
# omitted). Add a line here when a new workspace is scaffolded, or
# `pnpm install --frozen-lockfile` fails against the lockfile.
#
# `packages/ui` is deliberately absent: `apps/api` does not depend on it.
# Only what this image's workspace graph actually needs belongs here.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/core/package.json packages/core/package.json
RUN pnpm install --frozen-lockfile

# --- build -----------------------------------------------------------------
# Full install (including dev deps) from the cached layer above, then only
# the source this build actually needs.
#
# `@ostomy/core` is built BEFORE `@ostomy/api`, and that ordering is the
# whole point of this stage rather than an optimisation. `apps/api` resolves
# `@ostomy/core/sync`, `/validation`, `/units` and `/i18n` through the
# package's `exports` map, which points at `dist/` — and `.dockerignore`
# excludes `**/dist` (correctly: a host-built `dist` must never leak into an
# image). So the only `dist` that can exist here is one this stage produces.
#
# This is the root `build:deps` script's job outside Docker, which is why
# `pnpm verify` never caught its absence here: CI runs `verify`, and nothing
# in CI builds this image. `apps/api` gained its `@ostomy/core` dependency at
# P2.S1a and this file was last touched at P1.S3, so the image — and
# therefore `deploy-dev.yml`, which runs `docker compose build` — was broken
# for five merged PRs with no signal. Found by bringing the stack up for the
# Gate B walkthrough.
#
# If `apps/api` ever gains a second workspace dependency, it needs the same
# two lines: the source copied, and the package built before the API.
FROM deps AS build
COPY packages/config packages/config
COPY packages/core packages/core
COPY apps/api apps/api
RUN pnpm --filter @ostomy/core build
RUN pnpm --filter @ostomy/api build

# --- prod-deps ---------------------------------------------------------------
# `pnpm deploy --prod` produces a pruned, hoisted, prod-DEPENDENCIES-only
# node_modules for a single workspace — the "no dev dependencies in the
# runtime image" stage from docs/deployment-development.md. It packs the
# package's own files by the `files` field (apps/api/package.json now
# declares `"files": ["dist"]` — see that field's own comment for why
# `"prisma"` and `"prisma.config.ts"` were removed from it rather than kept
# for both stages), so `dist` must already exist from the `build` stage
# before this runs.
#
# `prisma` (the CLI) and `dotenv` are `devDependencies` again (CI-audit
# follow-up to P1.S3 — see apps/api/package.json's own comment). `--prod`
# alone does NOT exclude them, though — verified empirically, and this cost
# real time to track down, so recorded here in full rather than left as
# "just add --prod": `@prisma/client` (a genuine `dependencies` entry)
# declares `prisma` as an `optional: true` peerDependency. As long as
# `prisma` resolves ANYWHERE in this pnpm workspace's single shared
# lockfile — which it must, for the `migrate-deps` stage below and for
# local CLI use, per apps/api/package.json's own devDependencies — pnpm
# auto-links it to satisfy that peer and bakes it into `@prisma/client`'s
# lockfile snapshot as an `optionalDependencies` edge, REGARDLESS of which
# package.json section declares the satisfying `prisma`. `pnpm deploy
# --prod` only strips `devDependencies`; it walks `optionalDependencies`
# edges the same as `dependencies` edges, so without a second flag this
# stage still pulled in `prisma`'s entire tree — the CLI itself, `mysql2`,
# `postgres`, `@prisma/engines`, `@prisma/studio-core`, `@prisma/dev`, and
# `@prisma/config`'s `deepmerge-ts` — into what was supposed to be the
# prod-only tree. `--no-optional` (below) is what actually excludes it;
# `--prod` on its own is not sufficient here.
#
# `@prisma/client` and `@prisma/adapter-pg` themselves stay `dependencies`
# and are unaffected by `--no-optional` (they are not optional — only
# `@prisma/client`'s OWN peer on `prisma` is): the generated client imports
# `@prisma/client/runtime/client` directly at runtime (verified; see
# prisma/schema.prisma's generator-block comment), so pruning either would
# break `api` itself, not just `migrate`.
#
# `--legacy`: pnpm 10's default deploy implementation requires every
# workspace it deploys to opt in with `inject-workspace-packages=true`
# (verified against pnpm@10.34.5, the version pinned above), which this repo
# does not set. `--legacy` re-resolves prod dependencies straight from the
# pnpm content-addressable store instead — no network fetch, since `build`
# already populated the store — and still yields a pruned, hoisted,
# dev-dependency-free node_modules; only the resolution strategy differs.
FROM build AS prod-deps
RUN pnpm --filter=@ostomy/api deploy --prod --no-optional --legacy /out

# --- migrate-deps --------------------------------------------------------
# A second, separate `pnpm deploy` for the SAME workspace, this time without
# `--prod`. `prisma migrate deploy` (the CLI) and `prisma.config.ts`'s own
# `import 'dotenv/config'` need `prisma` and `dotenv`, and both are
# `devDependencies` — exactly what `--prod` above prunes and exactly why
# `migrate` cannot simply share `runtime`'s image the way it did before this
# stage existed (that sharing is what let a MySQL-driver advisory reachable
# only through the CLI block every PR in a Postgres application).
#
# This intentionally pulls in the REST of apps/api's devDependencies too
# (vitest, tsx, testcontainers, typescript, supertest, @nestjs/testing,
# @ostomy/config, the various @types/*) — `pnpm deploy` has no flag to
# deploy "prod dependencies plus these two specific devDependencies", only
# "prod" or "prod+dev" for the whole workspace. Accepted trade-off, not
# worked around: this stage is never `api`'s image, is never internet- or
# LAN-facing, and runs exactly one CLI command to completion before exiting
# — it is not part of the `pnpm audit --prod` gate (that gate reads
# apps/api/package.json's own dependencies/devDependencies split, which is
# already correct after this change, independent of what any Docker stage
# happens to contain) and not part of the request-serving attack surface
# `runtime` above is sized against. If `migrate`'s own image size or surface
# ever becomes a real concern, the fix is a hand-picked install of just
# `prisma`+`dotenv` against the already-populated pnpm store, not a smaller
# audit gate.
FROM build AS migrate-deps
RUN pnpm --filter=@ostomy/api deploy --legacy /out

# --- runtime-base ----------------------------------------------------------
# Shared setup for `runtime` and `migrate`: identical non-root user and /app
# ownership, so a stage split doesn't quietly leave one of the two images
# running as root. Non-root matters here specifically because the
# compose/deploy-dev runner is already in the `docker` group (a full
# host-compromise risk documented in docs/deployment-development.md and
# CLAUDE.md) — nothing inside a container this runner starts should
# additionally run as root.
FROM ${NODE_IMAGE} AS runtime-base
RUN groupadd --system app && useradd --system --gid app --home /app app
WORKDIR /app
# WORKDIR creates the directory as root before ownership is ever
# considered; `COPY --chown` below only chowns what it copies in, not this
# directory itself. Without this, `app` can read/execute everything it owns
# inside /app but cannot create a *new* file directly in /app — which is
# exactly what main.ts's best-effort openapi.json write does non-production,
# producing an EACCES warning on every boot (harmless — main.ts already
# treats this as best-effort — but avoidable).
RUN chown app:app /app

# --- runtime -----------------------------------------------------------------
# Serves the API. Unchanged in shape from before this stage split — still
# non-root, still `pnpm deploy --prod --legacy`-pruned — only its
# node_modules got smaller, because `prod-deps` above now actually excludes
# the CLI.
FROM runtime-base AS runtime
# No curl install: Node 24 ships a global `fetch` (undici-backed), which the
# HEALTHCHECK below uses directly — one fewer apt layer and one fewer piece
# of CVE surface in the runtime image than shelling out to curl would cost.
COPY --from=prod-deps --chown=app:app /out ./

USER app
ENV NODE_ENV=production
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://localhost:3000/api/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# No .env file in the image or the container — see
# docs/deployment-development.md "Secrets": configuration is injected as real
# environment variables by docker-compose.yml, which is why apps/api's
# `start` script (unlike `start:dev`) uses `--env-file-if-exists`.
CMD ["node", "dist/main.js"]

# --- migrate -----------------------------------------------------------------
# Runs `prisma migrate deploy` against MIGRATION_DATABASE_URL (see
# infra/docker-compose.yml's `migrate` service and apps/api/prisma.config.ts)
# — never serves HTTP traffic, so no EXPOSE/HEALTHCHECK.
FROM runtime-base AS migrate
COPY --from=migrate-deps --chown=app:app /out ./
# `prisma/schema.prisma`, `prisma/migrations/`, and `prisma.config.ts` are
# NOT in apps/api/package.json's `files` allow-list — that list packs
# identically for every `pnpm deploy` invocation of this package, and
# `runtime` above must not receive them at all. Copied explicitly here
# instead, straight from `build`'s own checkout of the source tree, so only
# this stage gets them. (Prisma ORM 7 moved the datasource URL out of
# schema.prisma into prisma.config.ts — see that file's own comment — so
# both are required, not just the schema.)
COPY --from=build --chown=app:app /workspace/apps/api/prisma ./prisma
COPY --from=build --chown=app:app /workspace/apps/api/prisma.config.ts ./prisma.config.ts

USER app
ENV NODE_ENV=production
CMD ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
