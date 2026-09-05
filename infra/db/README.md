# infra/db

`bootstrap-roles.sql` — sets the runtime role's LOGIN password, applied by
`infra/docker-compose.yml`'s `db-roles` service against the shared
development Postgres, every deploy, AFTER `migrate`. Read the comment at
the top of that file before changing it.

## The seam described here is now resolved (P1.S3)

This file used to own the whole two-role model — the runtime role's
existence, its attributes, and every grant it held. As of P1.S3, that split
across two places:

- **The runtime role's existence and every `GRANT` it holds** now live in
  the first Prisma migration
  (`apps/api/prisma/migrations/20260905000000_init_schema_core/migration.sql`).
  It creates the role `NOLOGIN`, idempotently (a `DO` block checking
  `pg_roles`, since plain SQL has no `CREATE ROLE IF NOT EXISTS` and a
  migration cannot use psql's `\gexec`/`:'var'` substitution — see that
  file's header comment). A role's existence and its privileges are not
  secrets, so this is safe to commit, and — critically — it means a
  Testcontainers-based integration test gets the real grant model for
  free just by running `prisma migrate deploy`, closing exactly the gap
  this section used to describe as future work.
- **This file's only remaining job is the password** — the one part of
  role setup that genuinely is a secret and therefore cannot live in a
  committed migration. It runs `ALTER ROLE ... WITH LOGIN PASSWORD ...`
  and nothing else.

One consequence worth being explicit about: this file now runs **after**
`migrate`, not before — it cannot `ALTER` a role the migration has not
created yet. `infra/docker-compose.yml`'s `depends_on` graph reflects that
(`db-roles` depends on `migrate`; `api` depends on both).

A Testcontainers-based integration test (see
`apps/api/src/prisma/prisma.integration.spec.ts`) never sees this file or
`docker-compose.yml` either. It runs `prisma migrate deploy` against its
own container to get the role and its grants, then runs the equivalent
one-line `ALTER ROLE ... WITH LOGIN PASSWORD ...` itself, as the owner
connection, with a throwaway per-test password, before connecting as the
runtime role — the same two-step split this file and the migration
represent, just performed by the test's own setup instead of Compose.

## Why the role/grant model is not just a `docker-entrypoint-initdb.d` script

The Postgres image runs anything mounted into
`/docker-entrypoint-initdb.d/` exactly once — the first time the data
directory is initialized. Two things follow from that, and both are why
the role/grant model does not live there:

1. **The shared dev host's `pgdata` volume already exists**, provisioned
   under the earlier single-superuser model, and later under the
   pre-P1.S3 role split. An `initdb.d`-only script would silently never
   run again there; a schema or role change would exist in this repo but
   not in reality until someone happened to run `scripts/dev-reset.sh`
   (which destroys the volume). `migrate` and `db-roles` both re-run every
   deploy instead, against whatever `pgdata` state is already there,
   specifically so landing a change like this one does **not** require a
   reset — see the P1.S3 migration's own "populated database" test for
   the case this matters most.
2. **Testcontainers-based integration tests never see this compose file at
   all.** They start their own ephemeral Postgres container directly, with
   no init-script mount and no `db-roles`/`migrate` service in front of
   it. A grant model that only lived in `docker-compose.yml` would be
   invisible to exactly the tests that exist to prove it (the
   audit-immutability criterion — ADR-0011 and SRS_v2 §4.6). Folding the
   role/grant DDL into the migration itself is what fixes that.

Per [ADR-0011](../../design-specs/decisions/0011-database-roles-and-audit-immutability.md),
the migration intentionally does **not** grant the runtime role blanket
access to future tables (no `ALTER DEFAULT PRIVILEGES ... ON TABLES`).
Every migration that creates a table must `GRANT` the runtime role exactly
what it needs, explicitly, in that same migration — friction that is the
control, not a gap to close later.
