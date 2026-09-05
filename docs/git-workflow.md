# Git Workflow

Branching model, commit conventions, and PR/review process.

This repo is worked by one human directing specialist Claude Code subagents. The process below is shaped by that: it optimizes for **one reviewable diff per unit of work**, because a single person accepts every change and the reviewer agents need a diff to review.

## Branches

`main` is the only long-lived branch. There is no `develop`.

One short-lived branch per sprint, named for the sprint ID in `design-specs/planning/v1-implementation-plan.md`:

```
sprint/p0-s1-workspace-tooling
sprint/p2-s1b-sync-endpoints
```

For work outside a planned sprint, use a descriptive prefix instead: `fix/`, `docs/`, `chore/`, `adr/`.

Branches are short-lived by design. If a branch has been open long enough to need a rebase onto a moved `main`, the sprint was too large — see the sizing rule below.

## `main` is deployed on every merge

`docs/deployment-development.md` triggers the development deploy on **push to `main`**. A squash merge is a push. So:

> **Merging a PR redeploys the development host and runs migrations against the persistent database.**

There is no staging buffer until P9. That is acceptable — the dev host is LAN-only and holds synthetic data only — but it means "accept this diff" and "deploy it" are one action. Do not merge a PR you are not willing to have running five minutes later.

If the dev host ends up in a bad state, `scripts/dev-reset.sh` wipes and reseeds. Nothing there is precious.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/). Scope is the workspace or area:

```
feat(api): add observations create endpoint with server-side re-enforcement
fix(core): reject zero volumes in tier 1 validation
chore(config): add AGPL header lint rule
docs(adr): record sync contract semantics as ADR-0001
```

Types in use: `feat`, `fix`, `chore`, `docs`, `test`, `refactor`, `build`, `ci`.

Reference the sprint ID and any acceptance criteria in the body, not the subject:

```
feat(mobile): add output entry screen with measured/estimated toggle

Sprint P2.S2b. Covers AC 2.1 AC1-AC4, AC 2.2 AC1, AC 13.1 AC1.
Save confirms from the local write, not the network response.
```

## Pull requests

**Every change goes through a PR.** Squash merge only, so `main` carries one commit per sprint and the squash subject becomes the sprint's entry in the history.

PRs exist here for two reasons that survive having only one human reviewer:

1. **The reviewer agents run on a diff.** `code-reviewer`, `hipaa-compliance-reviewer`, and `accessibility-copy-reviewer` are read-only by design — they report, and the main session applies fixes. Without a PR there is nothing to hand them.
2. **CI gates the merge**, and the merge is the deploy.

### PR description must state

- The **sprint ID** and its one-sentence goal.
- The **acceptance criteria** covered, by ID (`AC 13.1 AC3`). Where no spec AC exists — Epics 3–11, 15, 16 — say so explicitly and state what "done" meant instead.
- **Which reviewer agents ran, their verdict, and what happened to each finding** — applied, or waived with a reason.

### When a reviewer is blocking

`code-reviewer` runs on every PR. The other two run whenever they are relevant, and on these sprints they are **blocking**: the PR does not merge until every finding is applied, or explicitly waived in the PR body with a reason.

| Reviewer | Blocking on |
|---|---|
| `hipaa-compliance-reviewer` | P1.S5, P2.S1, P3.S3, P5.S3, P8.S1, and all of P9 |
| `accessibility-copy-reviewer` | P2.S2b, P2.S3, P3.S2, P6.S2, P7.S3 |

Elsewhere they are advisory: run them, record the verdict, and use judgement. A PR that touches PHI paths, auth, audit logging, logging or error tracking, seed data, infrastructure, or the admin boundary without a `hipaa-compliance-reviewer` pass is not ready regardless of sprint.
- Any **ADR** this change implements or supersedes.

### Sizing rule

If a sprint cannot be reviewed in one sitting, **split it before dispatch, not during review**. The implementation plan marks these as `L` and carries the split. A PR that has grown past one sitting mid-flight should be split into stacked PRs rather than reviewed in halves.

## Rules that are not negotiable

- **An accepted ADR that changes something `SRS_v2.md` states must update the spec in the same PR** — and `CLAUDE.md` where it changes a working rule. Otherwise the repo has two answers to the same question. See `design-specs/decisions/README.md`.
- **ADRs are immutable once accepted.** To change a decision, write a new ADR and mark the old one `Superseded by ADR-XXXX`.
- **Never commit a `.env`.** `.env.example` carries placeholders only. CI rejects a committed `.env`.
- **No real PHI in any commit, ever** — not in fixtures, not in a test, not in a screenshot attached to a PR, not temporarily to reproduce a bug. Development and staging are synthetic-only.
- **New source files under `apps/` and `packages/` carry the AGPL header** from `docs/license-header.md`. Enforced by lint, so this fails CI rather than review.
- **Never edit a `packages/core` path you do not own** (ADR-0007). Stop and report; the main session dispatches a sprint to the owning agent.

## Hooks and signing

Do not use `--no-verify` or bypass commit signing. If a hook fails, fix the cause.

## History

Squash merges keep `main` linear. Do not force-push `main`. Force-pushing your own unmerged sprint branch is fine.
