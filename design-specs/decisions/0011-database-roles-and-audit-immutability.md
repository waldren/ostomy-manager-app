# ADR-0011: Separate migration-owner and runtime database roles, and enforce audit immutability by grant

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Steven Waldren (accepted from P1.S2 compliance review)
- **Related:** SRS_v2 §5.2, §4.8 · [ADR-0002](0002-testing-strategy.md) · [ADR-0008](0008-admin-config-api-before-console.md) · `docs/deployment-development.md`

## Context

SRS_v2 §5.2 requires that every PHI create, edit and delete is audit-logged to an **append-only** store separate from application logs. The v1 implementation plan turns that into a P1.S5 exit criterion with deliberately precise wording: *"there is no code path **and no database grant** permitting `UPDATE`/`DELETE` on the audit table."* [ADR-0002](0002-testing-strategy.md) then cites that grant as the specific reason API integration tests run against a real PostgreSQL instance rather than a mocked Prisma client — a mock cannot express a privilege.

The P1.S2 development stack was built with the `postgres` image's default single role. Compliance review caught what that means: `POSTGRES_USER` is a **superuser**, and it will own every object migrations create. A superuser bypasses privilege checks entirely, and a table owner can re-grant privileges to itself.

So `REVOKE UPDATE, DELETE ON audit_events FROM ostomy` would execute, report success, and change nothing.

That is a worse outcome than having no control at all. The P1.S5 test would be written, would pass, and would prove nothing — and the append-only store that SRS §5.2 requires would be append-only by convention, discovered only when someone adds a well-meaning correction path that edits an audit row.

Surfaced by review at P1.S2, before the schema exists. This is the cheapest moment it will ever be fixable.

## Decision

The database has **two distinct roles with different privilege levels**, and audit immutability is enforced by grant:

1. **An owner role.** Owns the schema. Used only by the one-shot `migrate` service and by CI's Testcontainers setup. Never used to serve a request.
2. **A runtime role** — `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE`, `NOINHERIT`, `NOREPLICATION`. Used by the API for every request. Granted `CONNECT` and `USAGE ON SCHEMA public` and nothing else by default; each migration grants it explicitly per table. On `audit_events` it holds `SELECT`/`INSERT` and **no `UPDATE` or `DELETE` at all**.

Two DSNs, not one, in Compose and in `.env.example`.

**No blanket `ALTER DEFAULT PRIVILEGES`.** A table a migration creates without an explicit grant is inaccessible to the runtime role. That friction is the control: it means a new table's privileges are decided deliberately rather than inherited, and forgetting produces a loud error in development rather than a silent over-grant.

### What the owner role is, precisely — and the gap this leaves

In the **development** stack the owner is `POSTGRES_USER`, the `postgres` image's bootstrap superuser. Reusing it avoids a third role for a LAN-only synthetic-data box, and it does not weaken the property this ADR exists to protect: the runtime role is structurally separate and constrained, which is what makes the P1.S5 test capable of failing.

It is nonetheless weaker than it should be, and this document should not pretend otherwise. Migrations run with superuser rights they do not need, and anyone who points the API at the owner DSN loses every control here at once.

**Staging and production must create a non-superuser owner role** — RDS's master user is not it — with the runtime role as above. That is P9 work, and it is recorded here rather than in a later ADR because the gap is being accepted knowingly now, not discovered later.

**The role creation and the grant model live in a migration**, not only in `/docker-entrypoint-initdb.d`. This is the half that is easy to get wrong: Testcontainers starts its own PostgreSQL and never sees a Compose init script, so a grant model that lives only in Compose is invisible to precisely the tests [ADR-0002](0002-testing-strategy.md) created to verify it. A migration travels with the schema into every environment — dev, CI, staging, production.

## Consequences

**What this gets us.** The P1.S5 audit test becomes capable of failing. An `UPDATE` on `audit_events` from application code raises a privilege error from PostgreSQL rather than succeeding quietly, which is a control that holds against a bug, a careless migration, and a compromised application process alike — none of which a code-path convention survives. It also makes dev, CI, staging and production agree on the privilege model, so the first time anyone discovers a missing grant is not in production.

**What this costs.** Two connection strings to configure and keep straight in every environment, and a class of error — "permission denied for table X" — that arrives whenever a new table is added and the runtime grant is forgotten. That friction is the control working, but it is friction. Migrations must also now explicitly grant the runtime role access to anything they create, which is a step that will be missed at least once.

**What it forecloses.** Running the API as the schema owner, which is the default shape of nearly every Prisma tutorial and the thing a future contributor will reach for when a permission error blocks them. That is exactly why this is an ADR: the fix that makes the error go away is the one that silently removes the control.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Single superuser role (what P1.S2 shipped) | The grant is unenforceable — superusers bypass privilege checks and owners can re-grant to themselves. The P1.S5 test passes while proving nothing, which is worse than no test. |
| Enforce append-only in application code only | A convention, not a control. It cannot survive a bug, an ad-hoc `psql` session, or a compromised process, and SRS §5.2 asks for an append-only *store*, not an append-only intention. |
| A `BEFORE UPDATE OR DELETE` trigger that raises | Defence in depth and worth adding later, but a table owner can `ALTER TABLE ... DISABLE TRIGGER`. Grants are the stronger primitive; a trigger is a complement, not a substitute. |
| Roles only in `/docker-entrypoint-initdb.d` | Invisible to Testcontainers, which starts its own PostgreSQL — so the tests that exist to verify the grant would run against a database that never had it. The most likely wrong version of the right idea. |
| A non-superuser owner role in development too | Correct, and what staging and production must do. Skipped in development only to avoid a third role on a synthetic-data box; the runtime constraint that makes the audit test meaningful does not depend on it. Recorded above as a known gap rather than left implicit. |
| Defer to P9 with the rest of the hardening | The schema lands at P1.S3 and the audit interceptor at P1.S5. Retrofitting an ownership change after tables exist means a migration that reassigns ownership across the whole schema, on a persistent volume. |

## Spec impact

**No spec change.** SRS_v2 §5.2 requires an append-only audit store; this decides how that is enforced. `CLAUDE.md` is updated, because "the API does not run as the schema owner, and `audit_events` has no `UPDATE`/`DELETE` grant" is a rule a working session needs before writing a migration or a repository method.

## Compliance and safety review

This ADR exists because of a compliance finding, and it is the enforcement mechanism behind SRS §5.2's audit requirement. Three obligations follow into later sprints:

- **P1.S3** creates `audit_events` and must grant the runtime role `SELECT`/`INSERT` only, in the same migration.
- **P1.S5**'s integration test must run as the **runtime** role. A test connecting as the owner would pass regardless and would reproduce the exact defect this ADR fixes.
- Every later migration adding a table must grant the runtime role explicitly. Consider a test that asserts no table is missing a runtime grant, so the failure surfaces in CI rather than as a 500.

## Notes

Written at P1.S2, before any schema exists. Re-check at **P1.S5**, when the audit test is first written — that is the moment this decision is either load-bearing or was implemented wrongly.

Worth adding later, not now: a `BEFORE UPDATE OR DELETE` trigger on `audit_events` as defence in depth, and a CI assertion that the runtime role holds no `UPDATE`/`DELETE` on the audit table.
