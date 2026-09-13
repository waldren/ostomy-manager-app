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
| [0001](0001-sync-contract-and-conflict-semantics.md) | Define the sync wire contract with per-operation idempotency, tombstones, and a monotonic delta cursor | Accepted |
| [0002](0002-testing-strategy.md) | Use Vitest everywhere except mobile, integration-test the API against real PostgreSQL, and name acceptance criteria in tests | Accepted |
| [0003](0003-monorepo-task-tooling.md) | Use plain pnpm scripts for task orchestration; revisit a task runner at Gate C | Accepted |
| [0004](0004-canonical-storage-units.md) | Store all volumes in millilitres and all weights in kilograms; convert only at render time | Accepted |
| [0005](0005-decimal-volumetric-entry-and-conversion-rounding.md) | Accept decimal volumes on entry, and round to the nearest whole unit only when converting between measurement systems | Accepted |
| [0006](0006-i18n-library-and-shared-catalog.md) | Use i18next with one shared English catalog in `packages/core`, and Intl for all formatting | Accepted |
| [0007](0007-packages-core-ownership.md) | Partition `packages/core` by owning agent, read-only to everyone else | Accepted |
| [0008](0008-admin-config-api-before-console.md) | Build the admin configuration API at its final shape early; defer the admin console SPA to P8 | Accepted |
| [0009](0009-synthetic-seed-data-generation.md) | Generate synthetic seed data in `packages/seed`, writing through Prisma but validating against `packages/core` first | Accepted |
| [0010](0010-api-commonjs-module-system.md) | Build `apps/api` as CommonJS with `nodenext` resolution, against an ESM monorepo | Accepted |
| [0011](0011-database-roles-and-audit-immutability.md) | Separate migration-owner and runtime database roles, and enforce audit immutability by grant | Accepted |
| [0012](0012-entered-measurement-system-provenance.md) | Store the entered measurement system on every observation | Accepted |
| [0013](0013-delta-cursor-visibility-mechanism.md) | Close the delta cursor's visibility gap by withholding the in-flight transaction window | Accepted |
| [0014](0014-local-phi-encryption-and-device-ownership.md) | Encrypt the on-device clinical store, and bind it to one patient | Accepted |
| [0015](0015-biometric-local-access.md) | Biometric alone unlocks local data, but an enrolment change invalidates the token | Accepted |
| [0016](0016-patient-local-day-boundary.md) | A "day" is the patient's local day, captured at write time | Accepted |
| [0017](0017-phi-retention-deletion-and-the-audit-exception.md) | PHI lives for the account's lifetime, and deletion reaches the audit log | Accepted |

**ADR-0012 completes ADR-0005** rather than superseding it. ADR-0005's decisions all stand; it simply had no source of truth for the entry measurement system, and ADR-0012 supplies one. ADR-0005 is not edited, per the immutability rule above.

**ADR-0005 changed the spec.** SRS_v2 was updated to v2.4 in the same change: AC 2.1 AC 1 now accepts decimal volumes, and a new AC 2.1 AC 4 specifies conversion rounding.

### Decided elsewhere, deliberately not an ADR

- **Git workflow and branch strategy** — `docs/git-workflow.md`. Blocking for P0 but not architectural.
- **SNOMED CT estimation-technique code** — still open, and blocked on a terminology lookup rather than on engineering. Tracked in `design-specs/data-model/fhir-rxnorm-integration.md`; write an ADR when it resolves. Do not invent a code.

Decisions predating this folder are captured in `SRS_v2.md` §4 and summarized in `CLAUDE.md`.
