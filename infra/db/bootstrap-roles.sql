-- Two-role model for the shared development Postgres: an "owner" role that
-- migrations run as, and a deliberately unprivileged "runtime" role that
-- the API connects as. See infra/db/README.md for why this file exists
-- separately from docker-entrypoint-initdb.d, and ADR-0011
-- (design-specs/decisions/0011-database-roles-and-audit-immutability.md)
-- for the full rationale, including why there is no blanket default-grant
-- shortcut below.
--
-- Idempotent by construction: re-running this against a cluster that
-- already has the runtime role updates its password/attributes in place
-- rather than erroring, so rotating POSTGRES_RUNTIME_PASSWORD in .env and
-- redeploying is enough on its own -- no manual SQL, no dev-reset.
--
-- Invoked by the `db-roles` one-shot service in infra/docker-compose.yml as:
--   psql -v ON_ERROR_STOP=1 -v runtime_role=... -v runtime_password=... \
--        -v db_name=... -f bootstrap-roles.sql
-- connected AS the owner role (`-U ${POSTGRES_USER}`) -- ownership context
-- for the GRANT/REVOKE statements a later migration adds comes from that
-- connection, not from a SQL variable, so this file does not need one.
--
-- The owner role is not created here: it is ${POSTGRES_USER}, the Postgres
-- image's own bootstrap superuser, created by the image's entrypoint before
-- this script ever runs. Reusing it as "owner" avoids introducing a third
-- credential; the defect this file exists to fix is that the *runtime* role
-- was ALSO that same superuser, which made every REVOKE downstream a no-op
-- (a superuser bypasses privilege checks entirely, and a role that is a
-- member of / identical to the table owner can always re-grant itself
-- access). Runtime is a structurally separate, NOSUPERUSER role below, so
-- that failure mode cannot recur regardless of what gets revoked from it
-- later.

\set ON_ERROR_STOP on

-- No DO block: psql's client-side `:'var'`/`:"var"` substitution is not
-- performed inside a dollar-quoted string ($$ ... $$), which is exactly
-- where a DO block's body lives -- an earlier version of this file put the
-- variable references there and they were sent to the server completely
-- unsubstituted (a literal `:'runtime_role'`), which is a syntax error, not
-- a silent no-op, so it fails loudly rather than doing the wrong thing
-- quietly. `\gexec` (build the statement as a string with a plain,
-- top-level SELECT, then execute the result) keeps every substitution at
-- the top level instead.
--
-- Create only if missing; role attributes and password are set
-- unconditionally by the ALTER below either way, so this only decides
-- whether CREATE or ALTER runs first.
SELECT 'CREATE ROLE ' || quote_ident(:'runtime_role')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'runtime_role')
\gexec

ALTER ROLE :"runtime_role" WITH LOGIN PASSWORD :'runtime_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION;

GRANT CONNECT ON DATABASE :"db_name" TO :"runtime_role";
GRANT USAGE ON SCHEMA public TO :"runtime_role";

-- Deliberately no `ALTER DEFAULT PRIVILEGES ... GRANT ... ON TABLES` here.
-- A blanket "every future table gets full CRUD automatically" grant would
-- make the audit_events exception (see below) impossible to express
-- without an extra, easy-to-forget REVOKE layered on top of it -- and per
-- ADR-0011's "Consequences", that friction is treated as a feature, not an
-- oversight to engineer away: every migration that creates a table MUST
-- grant the runtime role exactly what it needs on that table, explicitly,
-- in the same migration. A table with no grant statement is a table the
-- API cannot touch at all ("permission denied for table X" on first use),
-- which is the control surfacing as a loud, immediate error rather than a
-- silent broad grant nobody reviewed.
--
-- Concretely, per ADR-0011, in whichever migration creates each table:
--   GRANT SELECT, INSERT ON audit_events TO <runtime_role>;              -- append-only: no UPDATE/DELETE, ever
--   GRANT SELECT, INSERT, UPDATE, DELETE ON <ordinary_table> TO <runtime_role>;
--   GRANT USAGE, SELECT ON <table>_id_seq TO <runtime_role>;             -- serial/identity columns
