#!/usr/bin/env bash
#
# Reject a committed .env file.
#
# .gitignore already covers .env, so this catches the case that matters: a file
# force-added past the ignore rule. Nothing on the development host may hold a
# production credential, and nothing in git may hold a secret at all
# (SRS_v2 §5.2, docs/deployment-development.md).
#
# .env.example is the permitted file and must contain placeholders only.

set -euo pipefail

# Anything tracked by git that looks like a real env file.
tracked=$(git ls-files -- '.env' '.env.*' '**/.env' '**/.env.*' \
  | grep -v -E '(^|/)\.env\.example$' || true)

if [[ -n "$tracked" ]]; then
  echo "ERROR: environment file(s) are tracked by git:" >&2
  echo "$tracked" | sed 's/^/  - /' >&2
  echo >&2
  echo "Only .env.example may be committed, and it must contain placeholders only." >&2
  echo "Remove with: git rm --cached <file>" >&2
  exit 1
fi

# .env.example must not contain anything that looks like a real secret.
if [[ -f .env.example ]]; then
  if grep -nE '=[[:space:]]*["'"'"']?(AKIA|ASIA|sk-|ghp_|github_pat_|eyJ)' .env.example >&2; then
    echo >&2
    echo "ERROR: .env.example appears to contain a real credential." >&2
    exit 1
  fi
fi

echo "OK: no environment files are committed."
