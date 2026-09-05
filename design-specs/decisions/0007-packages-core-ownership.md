# ADR-0007: Partition `packages/core` by owning agent, read-only to everyone else

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Steven Waldren (accepted from implementation-planning recommendation)
- **Related:** SRS_v2 §3.8, §4.1 · `.claude/agents/README.md` · [ADR-0001](0001-sync-contract-and-conflict-semantics.md) · [ADR-0006](0006-i18n-library-and-shared-catalog.md)

## Context

SRS_v2 §3.8 requires that validation rules are **defined once in `packages/core`** and executed on both clients and re-enforced server-side. That single definition is the whole point: a rule that exists in three places will diverge, and a divergent Tier 1 rule means a client accepts data the server rejects, or worse, the reverse.

The delivery model creates a direct threat to that. Work is executed by specialist subagents that each start with a fresh context window, cannot see each other's invocations, and cannot coordinate. Three of them consume `packages/core` — `react-web-developer`, `nestjs-api-developer`, `expo-mobile-developer` — and the current agent roster gives `react-web-developer` nominal ownership of the whole package while the other two will routinely need changes in it mid-sprint.

Left unresolved, the predictable outcome is that an API agent adds a validation helper it needs, a mobile agent adds a near-identical one under a different name in the same invocation window, and neither is aware of the other. The rules fork three ways — exactly what §3.8 exists to prevent, arriving through the delivery process rather than through the design.

Surfaced by implementation planning as decision D10.

## Decision

We will partition `packages/core` by owning agent. Each path has exactly one author; every other agent treats it as **read-only**.

| Path                           | Authored by            | Everyone else               |
| ------------------------------ | ---------------------- | --------------------------- |
| `packages/core/src/validation` | `react-web-developer`  | read-only                   |
| `packages/core/src/units`      | `react-web-developer`  | read-only                   |
| `packages/core/src/hydration`  | `react-web-developer`  | read-only                   |
| `packages/core/src/i18n`       | `react-web-developer`  | read-only                   |
| `packages/core/src/fhir`       | `fhir-data-modeler`    | read-only                   |
| `packages/core/src/sync`       | `nestjs-api-developer` | read-only                   |
| `packages/core/src/api-client` | generated from OpenAPI | never hand-edited by anyone |

**Conflict procedure.** An agent that needs a change in a path it does not own **stops and reports the need** rather than editing. The main session dispatches a separate S-sized sprint to the owning agent, then re-dispatches the blocked sprint.

Ownership is assigned by **subject-matter authority**, not by which app happens to consume the code most: `fhir-data-modeler` owns terminology because it owns LOINC, SNOMED and RxNorm decisions; `nestjs-api-developer` owns the sync types because the server is the authority on the contract it enforces.

## Consequences

**What this gets us.** A shared rule has exactly one author, so it cannot be silently forked by two agents working in windows that cannot see each other. It also gives the main session a visible signal — a stop-and-report — at precisely the moments when a shared contract is about to change, which is when a human should be looking.

**What this costs.** A real round trip. An agent mid-sprint that discovers it needs one more validation helper cannot simply add it; the sprint pauses, a second sprint is dispatched to the owning agent, and the first is re-dispatched. That is slower than letting the agent write the line, and it will be tempting to skip. Under [ADR-0006](0006-i18n-library-and-shared-catalog.md) the same cost applies to every new copy string, which is the case most likely to make this rule feel disproportionate.

**What it forecloses.** Nothing technical — the partition is a process convention over an ordinary package, and abandoning it costs nothing but the guarantee. That is also its weakness: it is enforced by dispatch discipline, not by tooling, so it fails silently if the main session stops honouring it.

## Alternatives considered

| Alternative                                                                  | Why not                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single owner for all of `packages/core` (the current roster's implied model) | Every API and mobile sprint blocks on the web agent for changes in code the web agent has no particular authority over — notably the sync wire types and FHIR terminology. Maximises round trips while putting decisions with the wrong specialist.  |
| Any agent may edit `packages/core` freely                                    | The default, and the one that will be re-proposed the first time the round trip is annoying. It is exactly the fork-three-ways failure §3.8 forbids, and the divergence is silent until a client and the server disagree about a rule in production. |
| Add a dedicated `packages/core` owner agent                                  | A fourth agent for a package no one works in full-time. Overlapping agents make delegation ambiguous, which the roster README rightly warns against.                                                                                                 |
| Enforce with CODEOWNERS                                                      | Worth adding as reinforcement, but it gates a PR, not an agent invocation. It catches the violation after the work is done rather than preventing it.                                                                                                |

## Spec impact

**No spec change.** §3.8's "defined once in `packages/core`" is preserved; this decides how that holds under multi-agent delivery.

## Compliance and safety review

Touches validation, and therefore patient safety, indirectly but materially. A forked Tier 1 rule means a client and the server disagree about what is structurally impossible; a forked Tier 2 rule means one client scolds where another does not. Both are process failures with clinical consequences, which is the reason this is an ADR rather than a note in a README.

`code-reviewer` should treat an edit to a `packages/core` path outside the sprint owner's partition as a finding.

## Notes

Enforced by dispatch discipline today. Adding a CODEOWNERS file at P0.S2 is recommended reinforcement and does not supersede this ADR.

Re-check at Gate C: if stop-and-report round trips have become the dominant source of delay, the right fix is probably a better-specified initial contract, not a looser ownership rule.
