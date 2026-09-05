# syntax=docker/dockerfile:1
#
# Multi-stage build for @ostomy/api, per docs/deployment-development.md
# "Image build". Build context is the repo root (see infra/docker-compose.yml
# `build.context: ..`) because a pnpm workspace install needs the root
# manifest, the lockfile, and every workspace's own package.json.
#
# Stages: base -> deps -> build -> prod-deps -> runtime.
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
# workspace with only a README stub, e.g. apps/web today, has none yet and
# is intentionally omitted). Add a line here when a new workspace is
# scaffolded, or `pnpm install --frozen-lockfile` fails against the lockfile.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile

# --- build -----------------------------------------------------------------
# Full install (including dev deps) from the cached layer above, then only
# the source this build actually needs.
FROM deps AS build
COPY packages/config packages/config
COPY apps/api apps/api
RUN pnpm --filter @ostomy/api build

# --- prod-deps ---------------------------------------------------------------
# `pnpm deploy` produces a pruned, hoisted, prod-only node_modules for a
# single workspace — the "no dev dependencies in the runtime image" stage
# from docs/deployment-development.md. It packs by the package's `files`
# field (apps/api/package.json declares `"files": ["dist", "prisma",
# "prisma.config.ts"]` for exactly this reason: apps/api/.gitignore excludes
# dist/, and pnpm's packing rules follow gitignore unless `files`
# overrides it), so `dist` must already exist from the `build` stage before
# this runs. `"prisma"` and `"prisma.config.ts"` were added at P1.S3 once
# schema.prisma and prisma/migrations/ existed — if either is ever removed
# from that list again, they get silently packed out of /out and
# `prisma migrate deploy` fails inside this image at runtime.
#
# `--legacy`: pnpm 10's default deploy implementation requires every
# workspace it deploys to opt in with `inject-workspace-packages=true`
# (verified against pnpm@10.34.5, the version pinned above), which this repo
# does not set. `--legacy` re-resolves prod dependencies straight from the
# pnpm content-addressable store instead — no network fetch, since `build`
# already populated the store — and still yields a pruned, hoisted,
# dev-dependency-free node_modules; only the resolution strategy differs.
FROM build AS prod-deps
RUN pnpm --filter=@ostomy/api deploy --prod --legacy /out

# --- runtime -----------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# No curl install: Node 24 ships a global `fetch` (undici-backed), which the
# HEALTHCHECK below uses directly — one fewer apt layer and one fewer piece
# of CVE surface in the runtime image than shelling out to curl would cost.

# Non-root: the compose/deploy-dev runner is already in the `docker` group
# (a full host-compromise risk documented in docs/deployment-development.md
# and CLAUDE.md), so nothing inside a container this runner starts should
# additionally run as root.
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
