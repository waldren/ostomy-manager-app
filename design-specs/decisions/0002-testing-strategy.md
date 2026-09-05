# ADR-0002: Use Vitest everywhere except mobile, integration-test the API against real PostgreSQL, and name acceptance criteria in tests

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Steven Waldren (accepted from implementation-planning recommendation)
- **Related:** SRS_v2 §7 · `docs/testing.md` · [ADR-0003](0003-monorepo-task-tooling.md)

## Context

`docs/testing.md` is a `TBD` stub, and every sprint in the v1 implementation plan states test-based exit criteria. Nothing can be dispatched to a builder subagent until the conventions exist, because each agent starts with a fresh context window and would otherwise invent its own.

Two constraints bind. First, the repo is a pnpm monorepo spanning a NestJS API, a Vite SPA, an Expo/React Native app, and shared packages — React Native does not share a test runner cleanly with the rest. Second, SRS_v2 §7 carries acceptance criteria for Epics 2, 12–14, 17 and 18 by ID, and those IDs are the only formal link between the spec and the code. Without a convention that preserves the link, the criteria become documentation nobody checks.

Surfaced by implementation planning, not by hitting the problem in code.

## Decision

We will:

1. Use **Vitest** for `packages/core`, `packages/ui`, `apps/api` unit tests, `apps/web`, and `apps/admin`.
2. Use **jest-expo** for `apps/mobile`.
3. Integration-test `apps/api` with **Supertest against a real PostgreSQL instance** (Testcontainers locally and in CI), not against a mocked Prisma client.
4. Use **Playwright** for web end-to-end tests. Defer mobile end-to-end tooling until Gate C.
5. Require that **any test covering a spec acceptance criterion names it in its `describe` block** — e.g. `describe('AC 13.1 AC3 — server-side re-enforcement')`.

## Consequences

**What this gets us.** A real database in integration tests exercises the constraint that matters most in this system and that a mock cannot express: `audit_events` having no `UPDATE` or `DELETE` grant. Mocking Prisma would let a test pass against a schema that permits audit tampering. The AC-naming convention makes spec coverage greppable, so `code-reviewer` can check it mechanically and a missing criterion is visible rather than assumed.

**What this costs.** Two test runners in one monorepo. The root `pnpm test` must fan out to both, CI must cache two toolchains, and a developer moving between `packages/core` and `apps/mobile` moves between two assertion dialects. Testcontainers also makes API integration tests substantially slower than mocked ones and adds a Docker dependency to CI.

**What it forecloses.** Consolidating on one runner later means rewriting whichever suite loses, and the mobile suite is the one that cannot move — so this is effectively permanent. Deferring mobile e2e means the offline-to-sync path has no automated end-to-end coverage until Gate C; it is verified by the Gate B walkthrough manually until then, which is a real gap and is accepted deliberately.

## Alternatives considered

| Alternative                          | Why not                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Jest everywhere                      | Consistent, and the option someone will reasonably raise again. Rejected because it is materially slower on the packages that make up most of the code, and the ESM/TypeScript configuration burden lands on every workspace to accommodate the one workspace that needs it. |
| Vitest everywhere including mobile   | Vitest does not carry the React Native preset cleanly. Making it work means maintaining transform configuration that Expo upgrades will repeatedly break.                                                                                                                    |
| Mock Prisma in API integration tests | Faster, but cannot exercise database grants, constraint violations, transactional audit-write coupling, or migration correctness — which is most of what these tests exist to prove.                                                                                         |
| Add mobile e2e (Maestro) now         | The sync path is the only thing worth end-to-end testing on mobile, and it does not stabilise until Gate C. Building the harness against a moving contract means rewriting it.                                                                                               |

## Spec impact

**No spec change.** SRS_v2 §7 defines what must be true; this decides how it is verified. `docs/testing.md` records the conventions and is the file builder agents read.

## Compliance and safety review

Touches PHI handling indirectly, through test fixtures. Two rules carry into `docs/testing.md`:

- Test data is synthetic and generated by the same rules as `packages/seed` ([ADR-0009](0009-synthetic-seed-data-generation.md)). No fixture may contain real or realistic-looking patient data, and CI must not be able to reach a database holding PHI.
- The audit-coverage integration test is a required test, not an optional one: a PHI write with no corresponding audit row must fail the suite.

## Notes

Revisit at Gate C alongside [ADR-0003](0003-monorepo-task-tooling.md): if PR CI time has become the bottleneck, the Testcontainers-based integration suite is the first place to look, not the runner split.

Mobile e2e tooling is an open decision deferred to Gate C.
