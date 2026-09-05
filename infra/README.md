# Infra

Deployment configuration, cloud infrastructure, and CI/CD definitions.

- **Development** (on-premise Docker Compose): methodology in `docs/deployment-development.md`.
  - `docker-compose.yml` — the stack: `postgres`, `minio`, `mock-oidc`, one-shot `migrate`, `api`, and static-placeholder `web`/`admin`. Run from the repo root — see `docs/getting-started.md`.
  - `docker/` — multi-stage Dockerfiles. `api.Dockerfile` is the real one (base → deps → build → prod-deps → runtime, non-root, `pnpm deploy`-pruned). `web.Dockerfile` / `admin.Dockerfile` are placeholders until `apps/web` (P2.S3) and `apps/admin` exist.
  - `placeholder-pages/` — the static pages `web.Dockerfile`/`admin.Dockerfile` serve.
  - Reset script: `scripts/dev-reset.sh` (repo-root `scripts/`, not here, so it sits next to the other operational scripts).
- **Staging and production** (AWS, via CDK): not yet defined. See SRS §4.6–4.7.
