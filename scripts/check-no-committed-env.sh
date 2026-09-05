#!/usr/bin/env bash
#
# Reject committed environment files and obvious credentials in .env.example.
#
# Nothing in git may hold a secret (SRS_v2 §5.2, docs/deployment-development.md).
# .env.example is the permitted file and must contain placeholders only.
#
# Note this is the fast, dependency-free layer. It does not cover a secret
# pasted into a tracked file that is not an env file — that needs a real
# scanner (gitleaks, or GitHub secret scanning with push protection), which
# should be added before this repo becomes public.

set -euo pipefail

# git pathspecs are relative to CWD, so running from a subdirectory would
# silently find nothing and report success.
cd "$(git rev-parse --show-toplevel)"

# Deliberately not `|| true` on the git call: a check that reports success
# when it could not run is worse than one that fails loudly.
all_tracked=$(git ls-files -- '.env' '.env.*' '**/.env' '**/.env.*' '.envrc' '**/.envrc')
tracked=$(printf '%s\n' "$all_tracked" | grep -v -E '(^|/)\.env\.example$' | grep -v '^$' || true)

if [[ -n "$tracked" ]]; then
  echo "ERROR: environment file(s) are tracked by git:" >&2
  printf '%s\n' "$tracked" | sed 's/^/  - /' >&2
  echo >&2
  echo "Only .env.example may be committed, and it must contain placeholders only." >&2
  echo "Remove with: git rm --cached <file>" >&2
  exit 1
fi

# Scan every .env.example, not just the root one.
status=0
while IFS= read -r example; do
  [[ -n "$example" && -f "$example" ]] || continue

  # Report key names and line numbers only. Echoing the matched line would
  # republish the credential into the CI log, which is readable by everyone
  # with repo access — a wider audience than the commit itself.
  hits=$(grep -nE \
    -e '=[[:space:]]*["'"'"']?(AKIA|ASIA|ghp_|github_pat_|xox[abpr]-|sk-|sk_live|rk_live|AIza|eyJ)' \
    -e '=[[:space:]]*["'"'"']?[a-z][a-z0-9+.-]*://[^:/@[:space:]]+:[^@[:space:]]+@' \
    -e 'BEGIN [A-Z ]*PRIVATE KEY' \
    "$example" | cut -d: -f1,2 | cut -d= -f1 || true)

  if [[ -n "$hits" ]]; then
    echo "ERROR: $example appears to contain a real credential:" >&2
    printf '%s\n' "$hits" | sed 's/^/  line /' >&2
    status=1
  fi
done < <(git ls-files -- '*.env.example' '.env.example')

if [[ $status -ne 0 ]]; then
  echo >&2
  echo "Replace the value with a placeholder. Never commit a working credential." >&2
  exit 1
fi

echo "OK: no environment files are committed."
