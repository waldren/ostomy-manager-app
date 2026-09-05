# infra/db

`bootstrap-roles.sql` — the two-role model (a migration/owner role, and a
deliberately unprivileged runtime role) that `infra/docker-compose.yml`'s
`db-roles` service applies against the shared development Postgres. Read
the comment at the top of that file before changing it.

## Why this is a standalone file, not a `docker-entrypoint-initdb.d` script

The Postgres image runs anything mounted into
`/docker-entrypoint-initdb.d/` exactly once — the first time the data
directory is initialized. Two things follow from that, and both are why
the role/grant model lives here instead:

1. **The shared dev host's `pgdata` volume already exists**, provisioned
   under the earlier single-superuser model. An `initdb.d`-only script
   would silently never run there; the role split would exist in this repo
   but not in reality, until someone happened to run `scripts/dev-reset.sh`
   (which destroys the volume) and noticed. `db-roles` runs this file
   every deploy instead, against whatever `pgdata` state is already there,
   specifically so landing this change does **not** require a reset.
2. **Testcontainers-based integration tests (P1.S3) never see this compose
   file at all.** They start their own ephemeral Postgres container
   directly, with no init-script mount and no `db-roles` service in
   front of it. A grant model that only lived in `docker-compose.yml` — as
   an `initdb.d` script or otherwise — would be invisible to exactly the
   tests that exist to prove it (the audit-immutability criterion at
   P1.S5; see [ADR-0011](../../design-specs/decisions/0011-database-roles-and-audit-immutability.md)
   and SRS_v2 §4.6).

## The seam for P1.S3

This file is deliberately plain SQL with no Prisma dependency, so it can be
pointed at from two places without duplication. When P1.S3 scaffolds
Prisma:

- **Fold this SQL's content into the first migration** (a manually authored
  `migration.sql` under `apps/api/prisma/migrations/`, not one `prisma
  migrate dev` can generate from the schema) rather than leaving it as a
  separate script indefinitely. Once it's part of the migration history,
  `prisma migrate deploy` applies it identically whether it's running
  against the compose stack or against a Testcontainers-managed database —
  which is what actually closes the gap described above, rather than just
  documenting it.
- Until that fold happens, any Testcontainers suite asserting the
  audit-immutability grant **must** run this file, plus whatever migration
  grants `audit_events` its `GRANT SELECT, INSERT` (never `UPDATE`/`DELETE`
  — ADR-0011), against its own container before making assertions — it
  will not inherit either from compose.
- Retire the `db-roles` compose service only once the Prisma migration
  covers the same ground; until then both must stay in sync.
- Per [ADR-0011](../../design-specs/decisions/0011-database-roles-and-audit-immutability.md),
  this file intentionally does **not** grant the runtime role blanket
  access to future tables (no `ALTER DEFAULT PRIVILEGES ... ON TABLES`).
  Every migration that creates a table must `GRANT` the runtime role
  exactly what it needs, explicitly, in that same migration — friction that
  is the control, not a gap to close later.
