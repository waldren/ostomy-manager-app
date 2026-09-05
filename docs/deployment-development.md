# Development Deployment

How the shared development environment is built, deployed, and reset.

This describes **development only**. Staging and production run on AWS per SRS §4.6–4.7 and share almost nothing with this setup beyond the application images themselves. That divergence is deliberate and its consequences are listed under [What this environment deliberately does not do](#what-this-environment-deliberately-does-not-do).

## Shape

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
4. **runtime** — `pnpm deploy --filter=@app/api --prod` to produce a pruned, hoisted `node_modules` with no dev dependencies, copied into a slim base. Runs as a non-root user.

The web and admin images are the same pattern, ending in an nginx stage serving the static build. The admin image must be built from a source tree that contains no patient data types (SRS §3.11); this is a code-organization property, not something the Dockerfile enforces.

Images are built on the server and tagged with the short git SHA plus `dev-latest`. There is no registry, so rollback means retaining the previous few SHA-tagged images rather than pulling an older tag — prune on a schedule, keeping the last five.

## Deployment pipeline

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

Lint, type-check, and unit tests run on the pull-request workflow using GitHub-hosted runners, not here — this workflow deploys what already passed.

**Runner operational notes.** The runner runs as a dedicated non-root user that is a member of the `docker` group. Membership in that group is effectively root on the host: anyone who can queue a workflow can run a privileged container. That is an accepted risk for a LAN-only box holding synthetic data, and it is the specific reason this host must never hold a production credential or real PHI. Keep the runner auto-updating and scope its repository access to this repository alone.

## Database lifecycle

- **Persistent named volume.** Data survives deploys, so accumulated test state is not lost on every push.
- **Migrations run automatically** as a one-shot `migrate` service that must exit successfully before `api` starts. Running them as a separate service rather than in the API entrypoint avoids concurrent migration attempts if the API is ever scaled to more than one replica.
- **Reset is explicit.** A `scripts/dev-reset.sh` (or `make dev-reset`) tears down the volume, recreates it, migrates, and reseeds. Nothing else may destroy data.

Because the volume persists, migrations are continuously exercised against existing rows — which is the failure mode that matters, since a migration that only ever runs against an empty schema is untested.

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

Postgres stays off the LAN by default; expose it temporarily when a GUI client is genuinely needed rather than leaving it bound. `ufw` allows the LAN subnet and denies everything else; nothing is port-forwarded at the router.

### Mobile clients

Expo is not containerized. The mobile app runs via Expo on a developer machine, with `EXPO_PUBLIC_API_URL` pointing at the server's LAN address. A physical test device must be on the same Wi-Fi.

Cleartext HTTP to a LAN address works in Expo Go and in debug builds, but this is a debug-only allowance: Android release builds block cleartext without an explicit network security configuration, and iOS requires an ATS exception for local networking in a standalone build. Do not carry either workaround into a release configuration.

## Secrets

A `.env` file on the server, excluded from git, with a committed `.env.example` documenting every key. Development secrets are low-value by construction — a mock OIDC signing key, a local Postgres password, MinIO root credentials — and are not rotated.

The rule that matters: **no production or staging credential is ever placed on this host.** The runner's `docker` group membership means a host compromise is a full compromise, so the only defense that holds is that there is nothing of value here.

## Observability

`docker compose logs` is the baseline. Optionally add Dozzle for a browser log viewer on the LAN. Sentry (SRS §4.8) points at a separate development project or is disabled outright; development noise in the production error stream is worse than no development error tracking.

## Host baseline

Ubuntu 26.04 LTS with Docker Engine and the Compose plugin. `unattended-upgrades` enabled. `ufw` restricted to the LAN. A dedicated non-root user for the runner. Volumes for `pgdata` and `miniodata` on a disk with room to grow, with free space monitored — a full disk on a Postgres volume is the most likely way this environment breaks.

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

## Open items

- **Mock OIDC image choice.** `navikt/mock-oauth2-server` is small, supports standard discovery and JWKS, and allows arbitrary claims — enough to validate token handling. Keycloak is the heavier alternative, worth it only if development needs real user management and MFA flows rather than issued tokens. Decide at scaffolding time.
- **Staging environment design.** Not yet specified. Everything on the "deliberately does not do" list becomes staging's responsibility, so staging should be designed against that list.
- **Resource sizing** for the host, once the API and its test suite exist and actual memory and disk behavior can be measured.
