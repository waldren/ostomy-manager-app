# Development Deployment

How the development environment is built, deployed, and reset.

This describes **development only**. Staging and production run on AWS per SRS §4.6–4.7 and share almost nothing with this setup beyond the application images themselves. That divergence is deliberate and its consequences are listed under [What this environment deliberately does not do](#what-this-environment-deliberately-does-not-do).

> ## ⚠️ What exists today, and what this document describes
>
> **Everything below the "Shape" heading describes a SHARED, ON-PREMISE host that has never been built** (#76). Read it as the design, not as a description of anything running.
>
> **What actually exists** is a Docker Compose stack each developer runs on their own machine — Docker Desktop on Windows, at the time of writing — brought up and torn down by hand. There is:
>
> - no on-premise Ubuntu server,
> - **no self-hosted runner** (`gh api .../actions/runners` returns `total_count: 0`), so
> - **`deploy-dev.yml` has never executed.** Merging to `main` queues a job that waits forever. See [Deploying by hand](#deploying-by-hand) for what to do instead.
>
> This mattered concretely: the stack sat three merges behind `main` while a client correctly reported "We could not load the colour choices yet" against a server that had never been given them — and the obvious reading of that is "the client is broken". `scripts/dev-stack-status.sh` exists so nobody spends an hour on that again.
>
> The on-premise design is **deferred, not abandoned**. When it is built, delete this banner rather than editing around it.

## Deploying by hand

This is the current procedure. It does the same four things `deploy-dev.yml` would, in the same order, and the order is what matters — `migrate` must complete before `api` starts.

```bash
# From the repo root, with a .env present (see Secrets below).
export BUILD_COMMIT="$(git rev-parse --short HEAD)"

docker compose --env-file .env -f infra/docker-compose.yml build
docker compose --env-file .env -f infra/docker-compose.yml run --rm migrate
docker compose --env-file .env -f infra/docker-compose.yml up -d
curl --fail --silent http://localhost:3000/api/v1/health && echo ' api is healthy'
```

**`BUILD_COMMIT` is not optional bookkeeping.** It is what `/api/v1/health` reports and what makes staleness detectable at all; omit it and the stack cannot say which commit it is running. (Reported in development only — see `apps/api/src/health/health.controller.ts` for why it is withheld elsewhere.)

Then confirm it took:

```bash
scripts/dev-stack-status.sh
```

That compares the running commit, the applied migrations and the published value sets against this checkout, and exits non-zero if they disagree. **`UNVERIFIED` is not `CURRENT`:** it means a check could not run, which is not evidence that anything is up to date.

`docker compose ... up -d --build api` alone is tempting and wrong — it skips the migrate step and the health check, which is how a schema change ends up half-applied.

## Shape

> The rest of this document is the on-premise design. See the banner above.

A single shared environment, fully self-contained, running under Docker Compose on an on-premise Ubuntu 26.04 LTS server. No AWS dependency of any kind. LAN access only, plain HTTP, synthetic data only.

| Decision | Choice | Why |
|---|---|---|
| Orchestration | Docker Compose on one host | Fast to rebuild and easy to reason about; staging becomes the Fargate parity gate |
| Instances | One shared environment | Lowest cost and complexity; contention only matters when two people need conflicting DB state |
| Backing services | All containerized, including a mock OIDC provider | Zero cloud dependency; works with the internet down |
| Hosting | On-prem Ubuntu 26.04 LTS | Hardware already available; no BAA needed since no PHI is present |
| Deploy path | Self-hosted GitHub Actions runner | Connects outbound to GitHub, so no inbound firewall rule is ever required |
| Access | LAN only, plain HTTP | Adequate for synthetic data; avoids certificate distribution |
| Frontends | Containerized and served from the server | One deploy yields a complete environment anyone on the LAN can open |
| Images | Built on the server by the runner | No registry to operate; layer cache stays warm on one machine |
| Database | Persistent volume, migrations on deploy, explicit reset command | Exercises the migration path continuously, which is where schema mistakes surface |
| Seed data | Scenario-based generator | Correlated multi-entity data is the only kind that can exercise the physician view and anomaly flagging |

## Topology

```
Developer laptop ──┐
                   │  LAN, plain HTTP
Test phone ────────┤
                   ▼
       ┌─────────────────────────────────────────────┐
       │  Ubuntu 26.04 LTS host                      │
       │                                             │
       │  GitHub Actions runner (outbound only)      │
       │                                             │
       │  ┌──────────── docker compose ───────────┐  │
       │  │  web (nginx)      :8080               │  │
       │  │  admin (nginx)    :8081               │  │
       │  │  api (Node/TS)    :3000               │  │
       │  │  migrate (one-shot, runs before api)  │  │
       │  │  db-roles (one-shot, before migrate)  │  │
       │  │  postgres         volume: pgdata      │  │
       │  │  minio            volume: miniodata   │  │
       │  │  mock-oidc                            │  │
       │  └───────────────────────────────────────┘  │
       └─────────────────────────────────────────────┘
                   │ outbound only
                   ▼
       RxNorm API (NLM, public)   GitHub (runner jobs)
```

Expo mobile is **not** deployed here. It runs on a laptop or device and points at the server's API address; see [Mobile clients](#mobile-clients).

## Two abstractions this environment forces into the code

These are architectural requirements, not dev conveniences. Without them, development and production diverge structurally rather than by configuration, and the difference is only discovered at staging.

**1. The OIDC issuer is configuration.** Production uses Cognito (two pools, per SRS §4.6); development uses a mock provider. The API must consume standard OIDC discovery — issuer URL, JWKS URI, audience, and an explicit claim mapping — and must not import a Cognito SDK or hardcode Cognito-shaped claims anywhere in request handling. Anything Cognito-specific belongs behind a provider adapter.

**2. Object storage is the S3 API, not AWS.** Production uses S3 with SSE-KMS; development uses MinIO. The API must take endpoint, region, credentials, and path-style addressing as configuration. MinIO requires path-style addressing, so this is not optional — code that assumes virtual-host-style S3 URLs will not work here.

A third, smaller one: **push delivery is behind an adapter.** Expo push (SRS §3.4) is stubbed to a log-only implementation in development. The interface is the same; only the binding differs.

## Image build

The API image is a multi-stage build. pnpm workspaces need care here — a naive `COPY . .` produces an image containing the entire monorepo and every package's dev dependencies.

Stages:

1. **base** — Node LTS slim, `corepack enable pnpm`.
2. **deps** — copy only `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and each workspace package's manifest; `pnpm install --frozen-lockfile`. Keeping source out of this layer means the dependency install is cached until the lockfile actually changes.
3. **build** — copy source, build `packages/core` and `apps/api`.
4. **runtime** — `pnpm deploy --filter=@app/api --prod --no-optional` to produce a pruned, hoisted `node_modules` with no dev dependencies, copied into a slim base. Runs as a non-root user.

`apps/api`'s image is actually two leaves off that shared `build` stage, not just the one (CI-audit follow-up to P1.S3 — see `infra/docker/api.Dockerfile`'s own stage-by-stage comments for the full mechanism, including a pnpm/Prisma peer-dependency quirk that made `--prod` alone insufficient): `runtime` (above, `ostomy/api`) serves the API, and a separate `migrate` leaf (`ostomy/api-migrate`) carries `prisma` the CLI plus `prisma/schema.prisma`, `prisma/migrations/`, and `prisma.config.ts` — none of which `runtime` needs or has. They are two distinct images, not one image built twice; `infra/docker-compose.yml`'s `migrate` service builds and runs `ostomy/api-migrate`, not `ostomy/api`.

The web and admin images are the same pattern, ending in an nginx stage serving the static build. The admin image must be built from a source tree that contains no patient data types (SRS §3.11); this is a code-organization property, not something the Dockerfile enforces.

Images are built on the server and tagged with the short git SHA plus `dev-latest`. There is no registry, so rollback means retaining the previous few SHA-tagged images rather than pulling an older tag — prune on a schedule, keeping the last five. `ostomy/api-migrate` is tagged and pruned on the same schedule as `ostomy/api` (`.github/workflows/deploy-dev.yml`'s tag/prune loops list it explicitly) — it is a real, independently-built image now, not a free side effect of tagging `ostomy/api`.

### Rollback

If a deploy's health check fails, `dev-latest` still points at the broken image (`restart: unless-stopped` keeps it running), and `.github/workflows/deploy-dev.yml` retains the last five SHA-tagged images per app precisely so there is something to roll back to. The recipe, run on the host:

```bash
git log --oneline -6 -- .          # find the short SHA of the last known-good commit
docker tag ostomy/api:<good-sha> ostomy/api:dev-latest      # repeat per app (web, admin) as needed
docker compose --env-file .env -f infra/docker-compose.yml up -d
```

This retags `ostomy/api`, the runtime image, only. It does **not** also retag `ostomy/api-migrate` — and does not need to for the case this recipe targets (bad application code in a deploy where the database is already correctly migrated): `docker compose ... up -d` still re-runs `migrate` to satisfy `db-roles`'/`api`'s `service_completed_successfully` dependency, but `prisma migrate deploy` against an already-migrated database is a no-op regardless of which build of the CLI ran it, per "Database lifecycle" below. If a bad deploy's regression is in the `migrate` stage itself (not application code, and not the schema) — a genuinely different, rarer failure — `docker tag ostomy/api-migrate:<good-sha> ostomy/api-migrate:dev-latest` before the same `up -d` is the equivalent step.

This retags a previously-built image as `dev-latest` and redeploys it — it does **not** roll back the database. There is no down-migration story here (P1.S3 onward): a schema change that shipped with the bad deploy stays applied. If the failure was schema-related, the safe recovery is forward (fix and redeploy), not backward: `dev-reset.sh` is the only way to get to a clean database, and it is destructive (wipes `pgdata`/`miniodata` — see "No backups" below), which is the tradeoff of not maintaining down-migrations in a synthetic-data-only environment.

## Deployment pipeline

**Not currently in service** — there is no runner, so this workflow has never run (#76). `deploy-dev.yml` is retained and disabled rather than deleted, because the sequence it encodes is correct and is what [Deploying by hand](#deploying-by-hand) reproduces.

A GitHub Actions workflow targeting the self-hosted runner (labels: `self-hosted`, `linux`, `x64`, `ostomy-dev`).

```
push to main
  → runner picks up job (outbound poll; no inbound port)
  → checkout
  → docker compose build
  → docker compose run --rm migrate
  → docker compose up -d
  → health check against /api/v1/health
  → prune images older than the last five
```

`docker compose run --rm migrate` starts `migrate`'s own dependencies first — including `db-roles`, the one-shot service that applies the migration-owner/runtime-role split (`infra/db/bootstrap-roles.sql`) — so the role model is (re-)applied on every deploy without a separate pipeline step for it.

Lint, type-check, and unit tests run on the pull-request workflow (`pr.yml`) using GitHub-hosted runners, not here. Be precise about what connects the two: nothing in either workflow file does — both trigger independently on push to `main`, with no `needs:`/`workflow_run:` between them, so this workflow deploys whatever is on `main` without checking that `pr.yml`'s run against that commit succeeded, or even finished. The actual enforcement is branch protection on `main` requiring `pr.yml` to pass before a merge is possible at all (an organizational GitHub setting, not a file in this repo); if that protection is ever relaxed, this workflow has nothing of its own to fall back on.

**Runner operational notes.** The runner runs as a dedicated non-root user that is a member of the `docker` group. Membership in that group is effectively root on the host: anyone who can queue a workflow can run a privileged container. That is an accepted risk for a LAN-only box holding synthetic data, and it is the specific reason this host must never hold a production credential or real PHI. Keep the runner auto-updating and scope its repository access to this repository alone.

## Database lifecycle

- **Persistent named volume.** Data survives deploys, so accumulated test state is not lost on every push.
- **Two Postgres roles, not one.** `migrate` connects as the migration/owner role and can create and alter anything; `api` connects as a separate, deliberately unprivileged runtime role (`NOSUPERUSER`, `NOCREATEDB`, `NOINHERIT`) that can only do what it has been explicitly granted, table by table, in the migration that creates each one — no blanket default grant (ADR-0011). This is what makes limiting `audit_events` to `GRANT SELECT, INSERT` (the P1.S5 audit-immutability exit criterion) an enforceable database grant rather than a no-op against a superuser that bypasses every privilege check. See `infra/db/README.md` and `infra/db/bootstrap-roles.sql`.
- **Migrations run automatically** as a one-shot `migrate` service that must exit successfully before `api` starts. Running them as a separate service rather than in the API entrypoint avoids concurrent migration attempts if the API is ever scaled to more than one replica.
- **Reset is explicit.** A `scripts/dev-reset.sh` (or `pnpm dev:reset`) tears down the volume, recreates it, migrates, and reseeds. Nothing else may destroy data.
- **Error log verbosity is `terse`, not the default.** `infra/docker-compose.yml`'s `postgres` service passes `-c log_error_verbosity=terse`. As of P1.S3 this database holds real PHI tables and CHECK constraints (`observations`'s value-positivity and canonical-unit checks, `value_set_members`'s code-immutability trigger's `RAISE EXCEPTION`, and so on); verified empirically that the default verbosity writes a constraint violation's full failing row — clinical values included — to a `DETAIL:` line on this container's stdout, and therefore into the `json-file` log driver, on every violation. `terse` suppresses that line. **This is a container-flag mitigation specific to this Compose stack, not a setting staging/production inherits automatically:** RDS has no `postgresql.conf` to edit directly — the equivalent control is the DB parameter group's `log_error_verbosity` parameter, and it must be set to `terse` there independently before RDS goes live with real PHI. Track this as a staging/production parity requirement, not something this file's existence already covers.

Because the volume persists, migrations are continuously exercised against existing rows — which is the failure mode that matters, since a migration that only ever runs against an empty schema is untested.

### Failed-migration recovery

Prisma marks a migration that fails partway through as `failed` in its own `_prisma_migrations` bookkeeping table, and every subsequent `prisma migrate deploy` — including the automated one this stack runs on every deploy — refuses to proceed while a failed migration is recorded, on purpose: it cannot know whether the failed migration's DDL partially applied.

Because deploys here are unattended (a self-hosted runner, not a human watching the output), a migration failure does not just fail one deploy — it wedges every deploy after it until someone intervenes by hand. Recovery:

1. **Inspect what actually happened.** Connect as the owner role (`docker compose exec postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"`) and check which of the failed migration's statements committed — Postgres DDL is transactional per statement in a single `migration.sql` file run this way, so this requires reading the migration and checking table/column/role state by hand, not assuming all-or-nothing.
2. **Manually finish or roll back** whatever the inspection above shows is incomplete.
3. **Tell Prisma the outcome** with `prisma migrate resolve` (run against the owner DSN, the same one `migrate` uses): `--applied <migration_name>` if step 2 finished applying it, or `--rolled-back <migration_name>` if step 2 undid it. Only after this does `prisma migrate deploy` proceed again.
4. **Redeploy.** The next `docker compose run --rm migrate` (or the automated pipeline's own invocation of it) now runs cleanly.

There is deliberately no automated version of this runbook. An automated "just mark it resolved and move on" step would silently paper over exactly the kind of partial-DDL state step 1 above exists to catch by hand.

## Seed data

A scenario-based generator, run by the reset script or invocable on demand. Every scenario must produce **correlated** intake, output, medication timing, appliance, and skin data — uncorrelated random values cannot exercise the physician view (§3.5), anomaly flagging, or range adaptation (§3.9), which are precisely the features hardest to verify by hand.

Scenarios to provide:

| Scenario | Purpose |
|---|---|
| `stable-ileostomy` | Well-controlled output over ~90 days; the baseline case |
| `high-output-dehydration` | Output climbing past the excessive threshold while intake stays flat and urine output falls; exercises anomaly flags and the §3.7 hydration indicator together |
| `new-post-op` | Two weeks since surgery, sparse entries; exercises early post-op default ranges and the §3.0 minimum-onboarding path |
| `leak-cluster` | Repeated leaks with shortening wear times and escalating skin severity; exercises §3.2 trends |
| `colostomy-baseline` | A colostomy profile, so ostomy-type-dependent ranges are visibly different |
| `validation-edge-cases` | Entries that legitimately trip Tier 2 soft warnings (§3.8), so warning behavior is testable without hand-crafting data |

Generator requirements:

- **Deterministic.** A fixed RNG seed, so a bug found against seeded data reproduces exactly.
- **Relative to now.** Timestamps are generated as offsets from the current date, so the dataset never ages into irrelevance and dashboards always have recent data.
- **Valid by construction.** Generated entries must pass Tier 1 validation (§3.8) and reference only active value-set members (§3.11) — except in `validation-edge-cases`, where tripping soft warnings is the point.
- **Synthetic, always.** Data is generated, never derived from or resembling real patient records. SRS §4.7 permits real PHI in production only; this environment is not eligible for it under any circumstance, including "just to reproduce a bug."

## Network and access

LAN only, plain HTTP. The server holds a static LAN address or a local DNS name.

| Service | Port | Exposure |
|---|---|---|
| web | 8080 | LAN |
| admin | 8081 | LAN |
| api | 3000 | LAN |
| minio console | 9001 | LAN |
| postgres | 5432 | compose network only |
| minio API | 9000 | compose network only |
| mock-oidc | 8090 | LAN (clients need to reach the issuer) |

Postgres stays off the LAN by default; expose it temporarily when a GUI client is genuinely needed rather than leaving it bound. Nothing is port-forwarded at the router.

**`ufw` does not enforce "LAN only" for anything Docker publishes, and it never has.** Docker implements `ports:` publishing as a DNAT rule in the `nat` table's `PREROUTING` chain, with the actual permit/deny decision made in the `filter` table's `FORWARD` chain — traffic destined for a published container port never traverses `INPUT`, which is the chain a normal `ufw allow from <LAN subnet>` rule governs. A host with `ufw` "restricted to the LAN" and a container publishing `0.0.0.0:PORT` is reachable from outside that restriction; `ufw` simply never gets asked. (Docker does add its own rules to a `DOCKER-USER` chain that `ufw` can be configured to cooperate with, but that is a deliberate, separate integration step this stack does not currently take.)

What actually enforces LAN-only here, since `ufw` does not: every published port is bound to `${DEV_BIND_ADDRESS}` (`.env`, defaulting to `127.0.0.1`) rather than the implicit `0.0.0.0` a short-form `ports:` entry would use — see every service's `ports:` entry in `infra/docker-compose.yml`. Set `DEV_BIND_ADDRESS` to the host's actual LAN address to make the stack reachable from the LAN, and to nothing broader than that. `ufw` still has a real, narrower job: it is what stops direct access to a port a container has *not* published (Postgres and the MinIO S3 API, both compose-network-only in the table below) from another process on the same host or a LAN client that somehow reaches the host's non-Docker-managed ports.

### Mobile clients

Expo is not containerized. The mobile app runs via Expo on a developer machine, with `EXPO_PUBLIC_API_URL` pointing at the server's LAN address. A physical test device must be on the same Wi-Fi.

Cleartext HTTP to a LAN address works in Expo Go and in debug builds, but this is a debug-only allowance: Android release builds block cleartext without an explicit network security configuration, and iOS requires an ATS exception for local networking in a standalone build. Do not carry either workaround into a release configuration.

### `DEV_HOST_ADDRESS` must be the real LAN address, not `localhost`

Found while building the stack at P1.S2, and it will cost someone an afternoon otherwise.

`mock-oauth2-server` embeds the **request's `Host` header** into the `iss` claim of every token it issues, rather than using a fixed issuer URL. The API compares `iss` by exact string equality. So a token minted by a laptop or phone that reached the server as `http://192.168.1.x:8090` carries that issuer, while an API configured against `http://localhost:8090` rejects it — with `AUTH_INVALID_ISSUER`, despite a perfectly valid signature.

Set `DEV_HOST_ADDRESS` in the server's `.env` to the host's actual LAN hostname or IP. Symptom if you get it wrong: every real client fails auth while `curl` from the server itself works.

This is a mock-specific quirk with **no Cognito equivalent** — Cognito's issuer is a fixed URL independent of how the request arrived — so it disappears at staging rather than being another deferred risk. It is documented here because it is a property of this environment, not a defect in the code.

## Secrets

A `.env` file on the server, excluded from git, with a committed `.env.example` documenting every key. Development secrets are low-value by construction — a mock OIDC signing key, a local Postgres password, MinIO root credentials — and are not rotated.

The rule that matters: **no production or staging credential is ever placed on this host.** The runner's `docker` group membership means a host compromise is a full compromise, so the only defense that holds is that there is nothing of value here.

## Observability

`docker compose logs` is the baseline. Optionally add Dozzle for a browser log viewer on the LAN. Sentry (SRS §4.8) points at a separate development project or is disabled outright; development noise in the production error stream is worse than no development error tracking.

## Host baseline

Ubuntu 26.04 LTS with Docker Engine and the Compose plugin. `unattended-upgrades` enabled. `ufw` restricted to the LAN — for ports Docker has not published; see "Network and access" above for why that is a narrower job than it sounds, and what actually keeps a published container port off addresses beyond the LAN. A dedicated non-root user for the runner. Volumes for `pgdata` and `miniodata` on a disk with room to grow, with free space monitored — a full disk on a Postgres volume is the most likely way this environment breaks.

**No backups.** This is deliberate, not an oversight: every byte here is either in git or regenerable by the seed script. The only non-reproducible state is the runner registration and the `.env` file, both of which are a few minutes to recreate. Do not let this environment accumulate anything that would make that untrue.

## What this environment deliberately does not do

Each of these is a real gap, deferred to staging rather than solved here. Staging is the parity gate; anything on this list is untested until it exists.

- **No PHI, ever.** Not for reproducing a bug, not temporarily.
- **No Fargate orchestration parity.** Service discovery, task definitions, health-check semantics, IAM task roles, and rolling-deploy behavior are all untested here.
- **No TLS.** Secure cookie flags, HSTS, and anything certificate-related are unexercised.
- **No Cognito.** Real token lifetimes, refresh rotation, MFA enforcement, hosted-UI flows, and the two-pool separation (§4.6) are validated at staging for the first time. The mock provider proves the API's OIDC handling is correct in shape, not that it is correct against Cognito.
- **No email flows.** With mock OIDC, verification and password reset do not exist here — Cognito owns them in staging and production. Nothing to stub because nothing runs.
- **No KMS, no SSE-KMS.** MinIO stands in for the S3 API surface, not for its encryption or key management.
- **No Multi-AZ, backup, or DR rehearsal.** The §5.3 RPO/RTO targets cannot be exercised on a single host.
- **No load or performance signal.** One box with synthetic volumes says nothing about the §5.1 targets.
- **No RDS parameter-group parity.** This Compose stack's `postgres` service sets `log_error_verbosity=terse` as a container command-line flag (see "Database lifecycle" above); RDS has no equivalent flag, only a DB parameter group, which staging/production must configure independently before real PHI reaches it.
- **No provisioning path for the runtime role's credentials.** Two gaps, both surfaced by the P1.S3 review and both landing at P9. They are recorded here rather than left to be rediscovered, because the pressure they create points at exactly the wrong answer.
  - The migration creates `ostomy_runtime` `NOLOGIN` with no password, in **every** environment. Development's `db-roles` service then sets one from `.env`. There is no staging or production equivalent — nothing yet performs the `ALTER ROLE … LOGIN PASSWORD` from Secrets Manager, so the API simply cannot connect there. The tempting fix is to point the API at the master user, which is precisely the reflex [ADR-0011](../design-specs/decisions/0011-database-roles-and-audit-immutability.md) exists to prevent.
  - The migration needs `CREATEROLE` on whichever role runs `prisma migrate deploy`, while ADR-0011 requires staging and production to use a **non-superuser owner**. A non-superuser owner without `CREATEROLE` cannot run this migration. Either the owner keeps `CREATEROLE` — considerably less dangerous on PostgreSQL 16+ thanks to the role-ownership model, and the mitigation to record if so — or the role is pre-provisioned out of band, which reintroduces the unverified-attributes hole the review found. Decide it when staging is built, not by discovering it.

## Open items

- **Mock OIDC image choice.** `navikt/mock-oauth2-server` is small, supports standard discovery and JWKS, and allows arbitrary claims — enough to validate token handling. Keycloak is the heavier alternative, worth it only if development needs real user management and MFA flows rather than issued tokens. Decide at scaffolding time.
- **Staging environment design.** Not yet specified. Everything on the "deliberately does not do" list becomes staging's responsibility, so staging should be designed against that list.
- **Resource sizing** for the host, once the API and its test suite exist and actual memory and disk behavior can be measured.
