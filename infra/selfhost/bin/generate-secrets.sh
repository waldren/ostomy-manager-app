#!/usr/bin/env bash
# Generates the self-hosted stack's secrets on the host itself (ADR-0022
# item 9). Run as root, on the host, once before the first `up`:
#
#   sudo infra/selfhost/bin/generate-secrets.sh /etc/ostomy/secrets
#
# - A secret that already exists is kept, never regenerated: replacing the
#   database passwords under a running volume would lock the stack out of its
#   own data. Rotation is a deliberate procedure (RD-14), not a re-run.
# - Nothing is printed except names. No value is ever echoed, logged, passed
#   as an argument, or written anywhere but its own file.
# - The directory is 0700 and owned by root, so no other account on the host
#   can read inside it. Each file is 0444 because Compose bind-mounts it into
#   containers that run as their own non-root users (the API as `app`,
#   PostgreSQL as `postgres`, Keycloak as uid 1000), which must be able to
#   read it. The directory's mode is what keeps it from everyone else.
# - Values are 64 hex characters: URL-safe, so they can sit inside a
#   connection string unescaped, and printable ASCII, which the SCRAM
#   verifier in infra/cdk/tasks/db-common.cjs requires.
#
# The secrets leave the host only inside encrypted backups (D.S1 slice 5).
set -euo pipefail

dir="${1:?usage: generate-secrets.sh <directory>}"

names=(
  postgres_superuser_password
  db_owner_password
  db_runtime_password
  keycloak_db_password
  keycloak_bootstrap_admin_password
)

umask 077
mkdir -p "$dir"
chmod 0700 "$dir"

for name in "${names[@]}"; do
  target="$dir/$name"
  if [[ -e "$target" ]]; then
    echo "kept    $name"
    continue
  fi
  # Written to a temporary file and renamed, so an interrupted run never
  # leaves a short secret behind for the next run to keep.
  tmp="$(mktemp "$dir/.$name.XXXXXX")"
  # `\r` as well: some openssl builds end the line with CRLF.
  openssl rand -hex 32 | tr -d '\r\n' >"$tmp"
  chmod 0444 "$tmp"
  mv "$tmp" "$target"
  echo "created $name"
done
