# Decisions (ADRs)

Architecture decision records — one file per significant decision, capturing the context, the decision, its consequences, and the alternatives rejected.

## Conventions

- One decision per file, named `NNNN-short-slug.md`, numbered sequentially from `0001`. Numbers are never reused.
- Copy `0000-template.md` to start. The template is not a form to fill in mechanically — delete sections that genuinely don't apply, but don't delete **Consequences** or **Spec impact**.
- ADRs are **immutable once accepted**. To change a decision, write a new ADR and set the old one's status to `Superseded by ADR-XXXX`. Editing an accepted ADR erases the reasoning someone will need later.
- `SRS_v2.md` remains the single source of truth. An ADR that changes something the spec states **must** update the spec (and `CLAUDE.md` where it changes a working rule) — otherwise the repo has two answers to the same question.

## What belongs here

Decisions that are expensive to reverse, that a future contributor would otherwise re-litigate, or that look arbitrary without their context: library and framework choices, schema and terminology decisions, sync and conflict semantics, auth and boundary design, environment and deployment structure, anything with a HIPAA or patient-safety dimension.

Not everything is an ADR. Routine implementation choices belong in the code and its tests.

## Index

| ADR | Title | Status |
|---|---|---|
| — | *No decisions recorded yet* | — |

Decisions predating this folder are captured in `SRS_v2.md` §4 and summarized in `CLAUDE.md`.
