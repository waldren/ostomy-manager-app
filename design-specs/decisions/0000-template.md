# ADR-0000: <short imperative title — the decision, not the topic>

- **Status:** Proposed | Accepted | Superseded by [ADR-XXXX](XXXX-slug.md) | Deprecated
- **Date:** YYYY-MM-DD
- **Deciders:** <who made the call>
- **Related:** SRS_v2 §X.Y | [ADR-XXXX](XXXX-slug.md) | issue/PR link

## Context

What forces make this a decision rather than an obvious default? Include the constraints that actually bind — spec requirements, HIPAA obligations, the offline-first write path, the on-premise development environment, the patient population. State what is *already settled* in SRS_v2 §4 and therefore not up for renegotiation here.

If this decision was surfaced by planning work rather than by hitting the problem in code, say so — a decision made ahead of the need should be re-checked when the need arrives.

## Decision

State it in one or two sentences, in the active voice: "We will …". Be specific enough that someone can tell whether a future PR complies.

## Consequences

**What this gets us.**

**What this costs.** Every real decision has a cost. An ADR with no downside section is usually an ADR that hasn't been thought through — name the thing that gets harder.

**What it forecloses.** What becomes expensive or impossible later, and roughly when we would find out.

## Alternatives considered

| Alternative | Why not |
|---|---|
| <option> | <the specific reason, not "worse"> |

Include the option someone will reasonably propose again in six months, so this ADR answers it.

## Spec impact

SRS_v2.md is the single source of truth. Pick one:

- **No spec change** — this decision sits below the level the spec describes.
- **Spec update required** — name the sections. An accepted ADR that contradicts the spec without updating it creates two competing sources of truth, which is worse than either alone. Update `CLAUDE.md` too if the decision changes a rule that working sessions need to know.

## Compliance and safety review

Does this touch PHI handling, audit logging, the admin/patient boundary, validation, or patient-facing safety copy? If yes, say what was checked and by whom. If no, one line saying so.

## Notes

Open questions, things to revisit, links to the discussion.
