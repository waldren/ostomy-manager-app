# ADR-0009: Generate synthetic seed data in `packages/seed`, writing through Prisma but validating against `packages/core` first

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Steven Waldren (accepted from implementation-planning recommendation)
- **Related:** SRS_v2 §3.8, §5.2 · `docs/deployment-development.md` · [ADR-0002](0002-testing-strategy.md) · [ADR-0004](0004-canonical-storage-units.md)

## Context

`docs/deployment-development.md` already settles the _content_ of development seed data: six named scenarios (`stable-ileostomy`, `high-output-dehydration`, `new-post-op`, `colostomy-baseline`, `leak-cluster`, `validation-edge-cases`), deterministic generation, timestamps relative to now rather than fixed dates, valid by construction, and synthetic always. `dev-reset` wipes and reseeds from it.

The non-negotiable constraint behind all of that is §5.2 and the development-environment rules in `CLAUDE.md`: **no real PHI outside production**, ever, not temporarily and not to reproduce a bug. The development host is a LAN-only Ubuntu box running plain HTTP, whose self-hosted runner is in the `docker` group — a host compromise there is total, and the only defence that holds is that there is nothing valuable on it.

What is not settled is where the generator lives and how it writes. That matters more than it looks: seed data that is not valid by construction produces a development database the application's own validation rules would reject, and every developer then debugs against data that could not exist.

Surfaced by implementation planning as decision D6.

## Decision

We will build a **`packages/seed` workspace** that writes through **Prisma directly**, and **validates every generated row against `packages/core` before insert**.

Generation is deterministic from a fixed seed. Timestamps are computed relative to run time. The `validation-edge-cases` scenario deliberately produces values that trip **Tier 2** soft warnings — that is its purpose — but never violates **Tier 1**.

`packages/seed` is a development and test dependency. It is never included in a production build, and it has no path to a production database.

## Consequences

**What this gets us.** Validation correctness without runtime coupling: the seeded database contains only rows the application would itself have accepted, so no one debugs against impossible data. Writing through Prisma keeps seeding fast and lets it run from the one-shot `migrate` container in the Compose stack with no API dependency, which is what `dev-reset` needs. Sharing the validation module with the clients and the server means a rule change automatically constrains the seed data too. And because generation is deterministic, a bug found against seeded data is reproducible by name and seed rather than by database dump — which matters here, since a database dump from a shared host is exactly the artifact that must never circulate.

**What this costs.** The generator bypasses the API, so it does not exercise the HTTP validation path, the audit interceptor, or the sync endpoints. Seeded rows therefore arrive **without audit events**, and any test asserting audit coverage must create its data through the API rather than the seeder — a distinction that is easy to forget and will produce a confusing failure the first time someone forgets it. `packages/seed` also gains a direct dependency on the Prisma schema, so a schema change can break seeding independently of the application.

**What it forecloses.** Little. Moving to API-based seeding later is possible but would make `dev-reset` depend on a running, authenticated API — the coupling this decision avoids.

## Alternatives considered

| Alternative                             | Why not                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Seed through the HTTP API               | Exercises validation, audit logging and auth for free, and will be re-proposed for exactly that reason. Rejected because it makes seeding slow, requires a running and authenticated API, and is awkward to invoke from the one-shot `migrate` container that `docs/deployment-development.md` specifies. Validating pre-insert gets the correctness guarantee without the coupling. |
| Write through Prisma with no validation | Simplest, and produces a development database containing rows the application would reject. Every developer then debugs against data that cannot occur in production.                                                                                                                                                                                                                |
| Raw SQL fixtures                        | Fast, but drifts from the schema silently and cannot use `packages/core` validation at all.                                                                                                                                                                                                                                                                                          |
| Faker with random seeds                 | Non-deterministic, so a bug found against seeded data is not reproducible — which is most of the value of having named scenarios.                                                                                                                                                                                                                                                    |

## Spec impact

**No spec change.** `docs/deployment-development.md` specifies the scenarios and their properties; this decides where the generator lives and how it writes.

## Compliance and safety review

Touches the no-real-PHI rule directly — the single most important constraint on the development environment.

- All generated data is synthetic by construction. No scenario may be derived from, seeded with, or shaped to match a real patient record, and no production dump may ever be used as a source.
- Names, dates of birth and identifiers are generated, not sampled from any real dataset.
- `packages/seed` must have no code path to a production database and must not appear in a production build.
- `hipaa-compliance-reviewer` audits the seed generator at P2.S4 and again whenever a scenario is added.

Per [ADR-0002](0002-testing-strategy.md), test fixtures follow the same rules.

## Notes

`leak-cluster` is deferred to P5, because the leak and appliance entities do not exist until then. The other five scenarios land at P2.S4 and P3.S5.

Tests that assert audit coverage must create data through the API, not through the seeder — see the cost noted above.
