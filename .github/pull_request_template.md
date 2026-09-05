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

- [ ] `code-reviewer` — **required on every PR**
- [ ] `hipaa-compliance-reviewer` — PHI paths, audit logging, auth, logging/error tracking, seed data, infrastructure, admin boundary. **Blocking** on P1.S5, P2.S1, P3.S3, P5.S3, P8.S1 and all of P9.
- [ ] `accessibility-copy-reviewer` — any user-facing UI or strings. **Blocking** on P2.S2b, P2.S3, P3.S2, P6.S2, P7.S3.
- [ ] Not applicable — say which, and why:

**Findings, and what happened to each:**

<!-- One line per finding: applied, or waived with a reason. "None" is valid
     only if a reviewer actually ran and reported none. -->

## Evidence

Not checkboxes — these want a filename or an answer, because a box gets ticked from habit.

- **Does this add or change a PHI write path?** If yes, name the integration test that fails when the audit row is absent, and confirm it covers the sync-applied path and the conflict loser:
- **Which logger config, serializer or `beforeSend` did you review**, and which test asserts no PHI reaches it?
- **Does this add a runtime dependency?** Name it and say what it touches:
- **Does this add or change an admin route or admin-adjacent module?**

## Decisions

**Implements ADR:** <!-- e.g. ADR-0001, or "none" -->

- [ ] This change does **not** contradict `SRS_v2.md`, **or** it updates the spec (and `CLAUDE.md` where a working rule changed) in this same PR.
- [ ] No `packages/core` path was edited outside its owner's partition (ADR-0007).

## Checks

- [ ] No real PHI anywhere — not in fixtures, tests, screenshots, or commit history. Synthetic only.
- [ ] New source files under `apps/` and `packages/` carry the AGPL header.
- [ ] No `.env` committed.
- [ ] This diff is reviewable in one sitting. If not, it should have been split before dispatch.
