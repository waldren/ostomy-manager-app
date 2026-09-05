# Subagents

Nine project-specific subagents for Claude Code. They are written for *this* codebase — the FHIR-shaped schema, the offline sync path, the admin/patient PHI boundary, the on-prem development environment — rather than adapted from generic role templates.

`CLAUDE.md` loads into every session automatically, so these agents deliberately **do not restate project rules**. They add role-specific depth and reference `CLAUDE.md` and `design-specs/requirements/SRS_v2.md` instead.

## Builders (can write code)

| Agent | Owns |
|---|---|
| `expo-mobile-developer` | `apps/mobile` — Expo/React Native, expo-sqlite, sync queue, reminders, biometrics |
| `react-web-developer` | `apps/web`, the future admin console, `packages/ui`, `packages/core` |
| `nestjs-api-developer` | `apps/api` — REST, guards/interceptors, sync + delta endpoints, provider adapters |
| `fhir-data-modeler` | PostgreSQL schema, Prisma models and migrations, LOINC/SNOMED/RxNorm terminology, FHIR `Bundle` export |
| `devops-deployment-engineer` | Docker Compose dev stack, GitHub Actions, AWS CDK, environment configuration |

## Planning (read-only)

| Agent | Does |
|---|---|
| `implementation-planner` | Sequences epics and features into dependency-ordered implementation plans, surfaces decisions that need making before work starts |

Planning is deliberately a subagent because it is context-expensive — reading the full spec plus the tree to arrive at a build order would otherwise consume the main session's window. It is the wrong tool for the running "what next" conversation, which stays interactive in the main session.

## Reviewers (read-only by design — they report, the main session fixes)

| Agent | Reviews |
|---|---|
| `hipaa-compliance-reviewer` | PHI exposure, audit-log coverage, access control, admin boundary, environment data rules |
| `accessibility-copy-reviewer` | WCAG 2.1 AA, 6th–8th grade plain language, tone rules, i18n externalization |
| `code-reviewer` | General correctness plus this project's specific tripwires, before merge |

Reviewers and the planner have no `Write`/`Edit` tools on purpose: a review that silently edits is hard to audit, and a plan should be read before it becomes files. Decisions the planner surfaces are recorded as ADRs in `design-specs/decisions/` by the main session.

## Deliberately not included

Considered and left out to keep the set small. Each is easy to add later if the need becomes real:

- **A "lead developer" coordinator agent** — subagents run in isolated context windows, start fresh each invocation, and cannot dispatch other subagents, so a coordinator agent would be a lead that cannot remember the conversation or call the specialists. The main session is the lead; `implementation-planner` covers the part that genuinely benefits from a separate context.
- **Separate QA/test-strategy agent** — each builder writes tests for its own area, and `code-reviewer` checks coverage of what changed. Worth adding once `docs/testing.md` is filled in and a real test suite exists.
- **Performance engineer** — SRS §5.1 deliberately defers numeric performance targets until post-spike. Add when there are targets to engineer against.
- **Documentation/technical writer** — `docs/*` are short and currently written alongside the work. Patient-facing copy is covered by `accessibility-copy-reviewer`.
- **TypeScript specialist** — every builder writes TypeScript; a separate types agent would overlap all of them.
- **Debugger, git-workflow, product/project manager, first-principles, UI designer** — either handled well by the main session, one-time setup work, or (for UI design) covered by the Claude Design workflow.
- **Separate `api-designer`, `docker-expert`, `postgres-pro`, `sql-pro`, `node-specialist`, `frontend-developer`, `mobile-app-developer`, `fullstack-developer`** — each overlapped an agent above. Overlapping agents make delegation ambiguous, which is worse than having fewer.
