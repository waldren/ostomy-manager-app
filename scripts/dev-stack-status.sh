#!/usr/bin/env bash
#
# Is the running development stack the code in this checkout?
#
# Written after #76, where the stack sat three merges behind `main` and nothing
# said so. The symptom was a client correctly reporting "We could not load the
# colour choices yet" against a server that had never been given them — and the
# obvious reading of that is "the client is broken". Reconstructing the truth
# took an image-creation timestamp, a `_prisma_migrations` query and a
# `value_sets` query, by hand, one at a time. This is those checks, in one
# command, so the next person spends a second on it instead of an hour.
#
# It answers one question and does not deploy anything. `docs/deployment-development.md`
# has the deploy procedure; this tells you whether you need it.
#
# Exit status is the point, so this is usable in a script or a pre-test hook:
#   0  the stack matches this checkout
#   1  the stack is stale, or something needed is missing
#   2  the stack is not running at all

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

ok()   { printf '  \033[32mok\033[0m      %s\n' "$*"; }
bad()  { printf '  \033[31mSTALE\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m    %s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }

stale=0
# Distinct from `stale`, because they warrant different verdicts. A check that
# could not run is not evidence that the stack is current, and reporting CURRENT
# on the strength of one is the same overconfidence #76 was made of.
unverified=0
API_CONTAINER=ostomy-dev-api
DB_CONTAINER=ostomy-dev-postgres

# --- is anything running at all ----------------------------------------------

step "Containers"
if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${API_CONTAINER}$"; then
  bad "${API_CONTAINER} is not running. Start the stack — see docs/deployment-development.md."
  exit 2
fi
ok "${API_CONTAINER} is up"
docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$" \
  && ok "${DB_CONTAINER} is up" \
  || { bad "${DB_CONTAINER} is not running"; stale=1; }

# --- which commit is it running -----------------------------------------------
#
# From `/api/v1/health`, which reports `buildCommit` in development. Asking the
# API rather than reading the image means this reflects what is actually
# serving requests, including a container started from an older image.

step "Commit"
HEAD_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
HEALTH="$(curl -s -m 5 http://localhost:3000/api/v1/health 2>/dev/null || true)"

if [[ -z "$HEALTH" ]]; then
  bad "the API did not answer on :3000 — it is up but not serving"
  stale=1
else
  RUNNING_SHA="$(printf '%s' "$HEALTH" \
    | python -c 'import json,sys; print(json.load(sys.stdin).get("buildCommit") or "")' 2>/dev/null || true)"
  if [[ -z "$RUNNING_SHA" || "$RUNNING_SHA" == "null" ]]; then
    # Not a failure by itself: a stack built before this field existed, or one
    # brought up without BUILD_COMMIT set, legitimately cannot say.
    warn "the API reports no build commit, so this check cannot compare. Rebuild with BUILD_COMMIT set (docs/deployment-development.md)."
    unverified=1
  elif [[ "$RUNNING_SHA" == "$HEAD_SHA" ]]; then
    ok "running ${RUNNING_SHA}, which is this checkout"
  else
    bad "running ${RUNNING_SHA}; this checkout is ${HEAD_SHA}"
    if git cat-file -e "${RUNNING_SHA}^{commit}" 2>/dev/null; then
      behind="$(git rev-list --count "${RUNNING_SHA}..HEAD" 2>/dev/null || echo '?')"
      bad "  the stack is ${behind} commit(s) behind this checkout"
    fi
    stale=1
  fi
fi

# --- has every migration been applied ----------------------------------------
#
# The check that would have caught #76 first: P3.S2's migration was absent, so
# the `observations` table could not hold a colour-only entry at all.

step "Migrations"
applied="$(docker exec "$DB_CONTAINER" bash -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "select migration_name from _prisma_migrations where finished_at is not null;"' \
  2>/dev/null | tr -d '\r' | sed '/^$/d' | sort || true)"

if [[ -z "$applied" ]]; then
  bad "could not read _prisma_migrations from ${DB_CONTAINER}"
  stale=1
else
  on_disk="$(find apps/api/prisma/migrations -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort)"
  missing="$(comm -23 <(echo "$on_disk") <(echo "$applied"))"
  if [[ -z "$missing" ]]; then
    ok "all $(echo "$on_disk" | wc -l | tr -d ' ') migration(s) applied"
  else
    while IFS= read -r m; do
      [[ -n "$m" ]] && bad "not applied: $m"
    done <<< "$missing"
    stale=1
  fi
fi

# --- are the value sets the client needs actually published -------------------
#
# Seeding a set and publishing it are two changes (see
# `PUBLISHED_VALUE_SET_KEYS`), and a client whose cache is empty degrades
# quietly. This compares what the migrations seed against what the database
# holds.

step "Value sets"
db_sets="$(docker exec "$DB_CONTAINER" bash -lc \
  'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -c "select key from value_sets;"' \
  2>/dev/null | tr -d '\r' | sed '/^$/d' | sort || true)"
# Python, not grep: these INSERTs span lines and `grep` is line-based, so a
# pattern that looks right matches nothing and the check passes vacuously —
# which it did on the first version of this script.
seeded="$(python - <<'PY'
import glob, re, sys

# Python on Windows writes CRLF, and command substitution strips only the LAST
# trailing newline — so every key but the final one kept a carriage return and
# silently failed to match, reporting three present value sets as missing.
# Fixed at the source rather than with a `tr` in the pipeline, because the
# escape needed for that does not survive nesting inside a heredoc.
sys.stdout.reconfigure(newline='\n')

keys = set()
for path in glob.glob('apps/api/prisma/migrations/*/migration.sql'):
    with open(path, encoding='utf-8') as handle:
        sql = handle.read()
    for stmt in re.findall(r'INSERT INTO "value_sets".*?;', sql, re.S | re.I):
        # The first quoted literal of each VALUES tuple is the set key.
        keys.update(re.findall(r"\(\s*gen_random_uuid\(\)\s*,\s*'([a-z_]+)'", stmt))
print('\n'.join(sorted(keys)))
PY
)"

if [[ -z "$db_sets" ]]; then
  warn "no value_sets rows, or the table could not be read"
else
  for key in $seeded; do
    if grep -qx "$key" <<< "$db_sets"; then
      ok "value set present: $key"
    else
      bad "value set missing: $key — a client picker will render its unavailable state"
      stale=1
    fi
  done
fi

# --- verdict -----------------------------------------------------------------

echo
if (( stale )); then
  printf '\033[31mSTALE\033[0m — the running stack is not this checkout.\n'
  printf 'Deploy it: see docs/deployment-development.md "Deploying by hand".\n'
  exit 1
fi
if (( unverified )); then
  printf '\033[33mUNVERIFIED\033[0m — every check that could run passed, but the\n'
  printf 'commit could not be compared, so this is not a statement that the stack\n'
  printf 'is current. Rebuild with BUILD_COMMIT set to make it one.\n'
  exit 1
fi
printf '\033[32mCURRENT\033[0m — the running stack matches this checkout.\n'
