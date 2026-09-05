<!--
See docs/git-workflow.md. Squash merge only.

Merging this PR pushes to main, which redeploys the development host and runs
migrations. Do not merge what you are not willing to have running immediately.
-->

## Sprint

**ID:** <!-- e.g. P2.S1b, or "n/a — out-of-sprint fix" -->

**Goal:** <!-- one sentence -->

## Acceptance criteria covered

<!--
List by ID, e.g. AC 13.1 AC3, AC 2.5 AC1. Each must have a test naming it in
its describe block (docs/testing.md).

SRS §7 has no acceptance criteria for Epics 3-11, 15, 16. If this sprint falls
there, write "No spec AC — Epic N" and state below what "done" meant instead.
-->

- [ ] Covered:
- [ ] No spec AC applies. Exit criteria used instead:

## Reviewer agents

Reviewers are read-only by design: they report, this PR applies the fixes.

| Agent                                                                                                                           | Ran     | Verdict |
| ------------------------------------------------------------------------------------------------------------------------------- | ------- | ------- |
| `code-reviewer` — **required on every PR**                                                                                      | ☐       |         |
| `hipaa-compliance-reviewer` — PHI paths, audit logging, auth, logging/error tracking, seed data, infrastructure, admin boundary | ☐ / n-a |         |
| `accessibility-copy-reviewer` — any user-facing UI or strings                                                                   | ☐ / n-a |         |

## Decisions

**Implements ADR:** <!-- e.g. ADR-0001, or "none" -->

- [ ] This change does **not** contradict `SRS_v2.md`, **or** it updates the spec (and `CLAUDE.md` where a working rule changed) in this same PR.
- [ ] No `packages/core` path was edited outside its owner's partition (ADR-0007).

## Checks

- [ ] No real PHI anywhere — not in fixtures, tests, screenshots, or commit history. Synthetic only.
- [ ] No PHI reachable by application logs or error tracking.
- [ ] New source files under `apps/` and `packages/` carry the AGPL header.
- [ ] No `.env` committed.
- [ ] This diff is reviewable in one sitting. If not, it should have been split before dispatch.
