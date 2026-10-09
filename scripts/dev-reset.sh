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
#   scripts/dev-reset.sh                        # colostomy-baseline
#   scripts/dev-reset.sh stable-ileostomy       # or any scenario run.js takes
#   DEV_SEED_SCENARIO=new-post-op scripts/dev-reset.sh
#
# ## Why the default is colostomy-baseline and not the ileostomy one
#
# It was `stable-ileostomy` until #114, which is the thinnest of the five: 90
# days of a single LOINC code. A developer resetting the stack therefore got a
# database that could not demonstrate several shipped features at all — no fluid
# intake means no Daily Net Fluid Balance, and no urine means nothing for §3.7's
# exclusion to exclude.
#
# Quick-Add was the sharpest case, because it did not merely show nothing. Its
# rule looks for entries repeated at least twice in fourteen days, no scenario
# modelled anyone with a habit, and so the only candidates were two RNG
# collisions at 0.1 mL granularity — which the dashboard then described as "you
# logged this 2 times recently", and which changed on every reseed.
#
# `colostomy-baseline` emits all three entry types and (since #114) seeds
# deliberate daily routines, so a reset stack shows one Quick-Add widget per
# path, the same ones every time. `stable-ileostomy` remains the ileostomy
# baseline and is one argument away.

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

# --- Seed ---------------------------------------------------------------------
# packages/seed (ADR-0009, P2.S4). Deterministic and timestamped relative to
# "now", so a bug reproduced against seeded data reproduces exactly and the
# dataset never ages into irrelevance (docs/deployment-development.md).
#
# Run from the `migrate` image, not `api`: that image installs devDependencies,
# and `@ostomy/seed` is deliberately one of them so `pnpm deploy --prod` keeps
# it out of the runtime image entirely. `compose run --rm` rather than `exec`
# because `migrate` is a one-shot that has already exited by this point.
#
# DEV_SEED_OIDC_SUBJECT is the `sub` claim the seeded patient answers to. It
# must match the subject your client's tokens carry, or every authenticated
# request is PATIENT_NOT_PROVISIONED against a database that looks full.
SEED_SUBJECT="${DEV_SEED_OIDC_SUBJECT:-dev-patient-1}"
# Argument first, then the environment, then the default — so a one-off is a
# word on the command line and a habit is a line in your shell profile. The
# scenario name is passed through to `run.js`, which validates it; this script
# deliberately holds no list of its own to go stale.
SEED_SCENARIO="${1:-${DEV_SEED_SCENARIO:-colostomy-baseline}}"
echo "==> Seeding ${SEED_SCENARIO} for OIDC subject '${SEED_SUBJECT}'..."
compose run --rm --no-deps -e ALLOW_SYNTHETIC_SEED=true migrate node dist/seed/run.js   --scenario "${SEED_SCENARIO}" --subject "${SEED_SUBJECT}"

echo "==> Reset complete."
