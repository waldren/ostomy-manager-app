# ADR-0003: Use plain pnpm scripts for task orchestration; revisit a task runner at Gate C

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Steven Waldren (accepted from implementation-planning recommendation)
- **Related:** SRS_v2 §4.1 · `docs/deployment-development.md` · [ADR-0002](0002-testing-strategy.md)

## Context

SRS_v2 §4.1 settles that the repo is a pnpm-workspace monorepo (`apps/*`, `packages/*`). It says nothing about a task runner, and the root `package.json` currently has an empty `scripts` block. Turborepo or nx is the obvious next reach, and someone will propose one.

The constraint that makes this non-obvious is `docs/deployment-development.md`, which already specifies a multi-stage Docker build strategy for the development stack. A task runner's caching layer has to be reconciled with that build strategy — remote caching, pruned lockfiles for Docker context, and the runner's own dependency graph all interact with how the images are staged. That reconciliation is real work, and it buys nothing until there are enough workspaces and enough test surface for cache hits to matter.

Surfaced by implementation planning. There are currently zero built workspaces, so this decision is being made with no measurements at all.

## Decision

We will orchestrate tasks with **plain pnpm workspace scripts** (`pnpm -r`, `--filter`) and no task runner. We will revisit at Gate C.

The trigger to revisit is **PR CI wall-clock time becoming a bottleneck**, not workspace count and not a general sense that the repo has grown.

## Consequences

**What this gets us.** No caching layer to reconcile with the Docker build strategy, no runner-specific pipeline configuration for builder agents to learn, and no third dependency-graph description competing with `pnpm-workspace.yaml` and the Dockerfiles. Root scripts stay legible to an agent that has never seen the repo before — which matters, because every builder subagent starts with a fresh context window.

**What this costs.** No task-level caching, so CI re-runs work that has not changed, and full-repo `lint`/`typecheck`/`test` get slower roughly in proportion to workspace count. No dependency-aware task scheduling, so cross-package build ordering is expressed by hand in scripts and can be got wrong silently. With the Testcontainers integration suite from [ADR-0002](0002-testing-strategy.md), CI time is the cost most likely to bite first.

**What it forecloses.** Almost nothing. Adding Turborepo later is additive — it wraps existing scripts rather than replacing them — which is exactly why deferring is cheap. The one thing that gets harder is that scripts written without a runner in mind sometimes assume a working directory or an implicit ordering that a runner then has to be configured around.

## Alternatives considered

| Alternative                                     | Why not                                                                                                                                                                                                                            |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adopt Turborepo now                             | The option to re-propose at Gate C, and the right one once there is measurable CI pain. Rejected now because its caching must be reconciled with an already-specified multi-stage Docker build, and there is nothing yet to cache. |
| Adopt nx now                                    | Everything above, plus a heavier generator and plugin model that would shape how workspaces are scaffolded before we know what the workspaces need.                                                                                |
| Decide at P0 based on projected workspace count | Workspace count is the wrong signal. Five small workspaces with fast tests need no runner; two workspaces with a slow integration suite do. Measure the thing that hurts.                                                          |

## Spec impact

**No spec change.** SRS_v2 §4.1 specifies pnpm workspaces, which this preserves.

## Compliance and safety review

No PHI, audit, boundary, validation, or patient-safety dimension.

## Notes

Revisit at Gate C. Bring a measurement: PR CI wall-clock time, and which job dominates it. If the answer is the Testcontainers integration suite, a task runner will not fix it and the conversation belongs in [ADR-0002](0002-testing-strategy.md) instead.
