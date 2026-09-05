# ADR-0008: Build the admin configuration API at its final shape early; defer the admin console SPA to P8

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Steven Waldren (accepted from implementation-planning recommendation)
- **Related:** SRS_v2 §3.8, §3.9, §3.11, §4.6, §5.2, AC 13.2 AC 2 · [ADR-0007](0007-packages-core-ownership.md)

## Context

SRS_v2 §3.11 requires an internal administration console with zero PHI access, backed by its own Cognito user pool disjoint from the patient pool, consuming an isolated `/api/v1/admin/...` surface. §3.8 separately requires that **all numeric validation bounds are admin-managed configuration, not constants in code**, and §3.9 requires clinical default range tables keyed to ostomy type and time since surgery.

Those two requirements have very different timing. The configuration _data_ is load-bearing from the very first validation rule — a Tier 2 threshold hardcoded at P1 is a spec violation and a rewrite later. The configuration _UI_ is not needed until someone other than the developer needs to change a threshold.

Deferring both would mean shipping hardcoded thresholds and retrofitting configuration through the validation layer. Building both early would mean building a full SPA, a second identity pool, and MFA before a single patient-facing feature exists.

Surfaced by implementation planning as decision D5.

## Decision

We will split them.

**Early (P1.S3 and P3.S3):** the configuration tables — `value_sets`, `value_set_members`, `clinical_default_ranges`, `validation_thresholds`, `effective_ranges` — and the `/api/v1/admin/...` API surface, built **at its final shape**: a structurally separate `AdminJwtAuthGuard` on a different issuer and audience, sharing no code with the patient guard; every change audit-logged with admin identity and before/after values; value-set members retired, never deleted.

**Later (P8):** the admin console SPA in `apps/admin`.

**In between:** configuration is seeded by migration and changed by a maintenance script.

"Final shape" is the binding part of this decision. The admin API is not a temporary internal endpoint to be hardened later; it is the real thing, with the console arriving as its first UI client.

## Consequences

**What this gets us.** Validation is spec-compliant from P1 — thresholds are injected data, never constants — so AC 13.2 AC 2 becomes satisfiable at Gate E without touching the validation layer. The identity-layer boundary (§4.6) is established at P1.S1, when the two guards are written, rather than being introduced late into a codebase that has grown used to one guard. And roughly a phase of SPA, second-pool and MFA work moves behind the four hydration signals, which are the product.

**What this costs.** Between P3 and P8, changing a clinical threshold means running a script against the database rather than clicking a UI. That is acceptable while the only operator is the developer, and it stops being acceptable the moment a clinician needs to tune a range — which is the real trigger for P8, more than the phase ordering is. The maintenance script is also throwaway work.

**What it forecloses.** Nothing, **provided the API is genuinely built at final shape**. If it is built as a shortcut — a shared guard with a role check, unaudited writes, hard deletes on value-set members — then P8 becomes a rewrite of the API rather than the addition of a client, and the boundary that §4.6 makes architectural will have been an authorization-logic property in the meantime. That is the failure mode this ADR exists to prevent, and it would first become visible at P8.S1 when the import-boundary lint rule starts failing.

## Alternatives considered

| Alternative                                     | Why not                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Build console and API together, early           | Front-loads a full SPA, a disjoint Cognito pool and MFA before any patient-facing feature exists, delaying Gate B for capability only the developer would use.                                                                                                                                     |
| Defer both, hardcode thresholds until P8        | Violates §3.8 directly, and means retrofitting configuration injection through a validation layer both clients and the server already depend on — the most expensive version of this work.                                                                                                         |
| Build a shortcut admin API now, harden it at P8 | The tempting middle path, and the one this ADR explicitly rejects. A shared guard with a role check makes the admin/patient boundary an authorization property rather than an identity property, contradicting §4.6, and every month it exists is a month of code written against the wrong shape. |
| Use the patient API with an admin role          | Same objection, stated more plainly: §3.11 and §4.6 put the boundary at the identity layer precisely so it cannot be defeated by an authorization bug.                                                                                                                                             |

## Spec impact

**No spec change.** §3.11 requires the console; this sequences it. Nothing in the spec dictates when it is built.

## Compliance and safety review

Touches the admin/patient boundary, audit logging, and access control — the highest-sensitivity area in the system. Requirements carried into implementation:

- `AdminJwtAuthGuard` is structurally separate from `JwtAuthGuard` from P1.S1, on a different issuer and audience, sharing no code. Never one guard with a role check.
- Every admin configuration write is audit-logged with admin identity and before/after values, to the same append-only store as PHI changes.
- Value-set members are retired, never deleted, so a retired code still resolves when rendering historical clinical records (§3.11). No admin action may change what a past entry means.
- The P0.S1 import-boundary lint rule exists from P0 even though `apps/admin` does not, and must fail the build at P8.S1 if any patient data type is imported.

`hipaa-compliance-reviewer` is blocking on P3.S3 and P8.S1.

## Notes

The trigger to pull P8 forward is a clinician — rather than the developer — needing to change a threshold. That is a product event, not a schedule one, and it should override the phase ordering if it happens early.
