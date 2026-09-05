#!/usr/bin/env bash
#
# Wipes and recreates the shared development stack's data, then brings it
# back up clean. Nothing else may destroy data (docs/deployment-development.md
# "Database lifecycle").
#
# Safe by construction: docs/deployment-development.md "No backups" is
# deliberate — every byte on this host is either in git or regenerable by
# the seed script, so a wipe here loses nothing that isn't already
# elsewhere. This is exactly why the dev host may never accumulate anything
# that would make that untrue (CLAUDE.md, docs/security-hipaa.md).
#
# Usage (from the repo root, or anywhere — this cds to the repo root itself):
#   scripts/dev-reset.sh

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found at the repo root. Copy .env.example to .env and fill it in first." >&2
  exit 1
fi

compose() {
  docker compose --env-file .env -f infra/docker-compose.yml "$@"
}

echo "==> Stopping the stack and removing its data volumes (pgdata, miniodata)..."
compose down --volumes --remove-orphans

echo "==> Rebuilding and starting the stack (migrate runs before api)..."
compose up -d --build

echo "==> Waiting for api to report healthy..."
attempts=0
max_attempts=60 # 60 * 2s = up to 2 minutes
until [[ "$(docker inspect --format='{{.State.Health.Status}}' ostomy-dev-api 2>/dev/null || echo starting)" == "healthy" ]]; do
  attempts=$((attempts + 1))
  if [[ $attempts -ge $max_attempts ]]; then
    echo "ERROR: api did not become healthy in time. 'docker compose -f infra/docker-compose.yml logs api' for details." >&2
    exit 1
  fi
  sleep 2
done
echo "==> api is healthy."

# --- Seed hook ---------------------------------------------------------------
# packages/seed (design-specs/planning/v1-implementation-plan.md, P2.S4) does
# not exist yet, so there is nothing to invoke here — the database is empty
# after migration. When it lands, call its deterministic, scenario-based
# generator here (ADR-0009), e.g.:
#
#   compose exec -T api node dist/seed/run.js --all-scenarios
#
# Deterministic (fixed RNG seed) and timestamped relative to "now", so a bug
# reproduced against seeded data reproduces exactly and the dataset never
# ages into irrelevance (docs/deployment-development.md "Seed data").
echo "==> No seed generator yet (packages/seed lands at P2.S4, ADR-0009) — database is empty after migration."

echo "==> Reset complete."
