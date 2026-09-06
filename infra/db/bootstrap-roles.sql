-- Sets the runtime role's LOGIN password. That is now this file's ONLY
-- job (P1.S3) — the runtime role's EXISTENCE and every GRANT it holds
-- moved into the first Prisma migration
-- (apps/api/prisma/migrations/20260905000000_init_schema_core/migration.sql),
-- which creates it NOLOGIN, no password, and is what a Testcontainers
-- integration test can actually see (this file cannot be — see that
-- migration's own header comment for why the split landed this way, and
-- infra/db/README.md "The seam for P1.S3" for the history).
--
-- Consequence: this file can no longer run BEFORE the migration — the role
-- does not exist until the migration creates it. infra/docker-compose.yml
-- sequences `db-roles` (this file) AFTER `migrate`, the reverse of the
-- pre-P1.S3 ordering.
--
-- Idempotent by construction: re-running this against a role that already
-- has a password just sets it again, so rotating POSTGRES_RUNTIME_PASSWORD
-- in .env and redeploying is enough on its own -- no manual SQL, no
-- dev-reset.
--
-- Invoked by the `db-roles` one-shot service in infra/docker-compose.yml as:
--   psql -v ON_ERROR_STOP=1 -v runtime_role=... -v runtime_password=... \
--        -f bootstrap-roles.sql
-- connected AS the owner role (`-U ${POSTGRES_USER}`).
--
-- `runtime_role` is still passed as a variable here (unlike in the
-- migration, where it is necessarily a literal — see that file's header
-- comment on why a migration cannot parameterize an identifier at deploy
-- time). If POSTGRES_RUNTIME_USER in .env is ever changed from the
-- 'ostomy_runtime' the migration hardcodes, this file's `-v runtime_role=`
-- argument alone will NOT follow it — the migration must also be updated
-- (via a new, additive migration; never edit an already-applied one), or
-- this `ALTER ROLE` will target a role name the migration never created.

\set ON_ERROR_STOP on

ALTER ROLE :"runtime_role" WITH LOGIN PASSWORD :'runtime_password';
