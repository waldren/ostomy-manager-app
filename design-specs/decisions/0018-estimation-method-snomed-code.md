# ADR-0018: Record a volumetric entry's Measured/Estimated toggle as an explicit SNOMED CT qualifier

- **Status:** Accepted (amended 2026-09-18 — see "Amendment")
- **Date:** 2026-09-17, amended 2026-09-18
- **Deciders:** Steven Waldren
- **Related:** SRS_v2 §4.4, AC 2.2 AC2, AC 2.5 AC2 | [ADR-0001](0001-sync-wire-contract.md) | `docs/sync-contract.md` §7.2 | `design-specs/data-model/fhir-rxnorm-integration.md` | decision D4 in `design-specs/planning/v1-implementation-plan.md`

## Context

The Measured/Estimated toggle is mandatory on every volumetric entry (SRS §3.1, AC 2.2 AC1), and the choice is stored as FHIR `Observation.method` — populated with a SNOMED CT code when estimated, `null` when measured. **`Observation.method` is the only stored representation of that choice.** There is no second column, no flag, and no derived field: if the code is wrong or absent, an estimated entry becomes indistinguishable from a measured one, permanently, and AC 2.2 AC2's history badges are silently wrong with nothing to migrate back from.

The code itself was decision **D4**, open since P1.S4 and deliberately left unresolved. `packages/core` modelled it as a discriminated union in the `{ resolved: false }` state — with no `code` property at all — so that a write path could not typecheck against an unresolved code by accident. The plan's own words: "a wrong SNOMED code is a silent, durable data-quality defect that only surfaces at FHIR export or EHR integration", i.e. after many rows already carry it.

D4 blocked real work. `apps/mobile`'s Add Output screen (P2.S2b) shipped with both toggle options present — the choice is mandatory, so offering only one would be worse — but choosing Estimated could not save. This was a terminology lookup, not an engineering decision, and it is now answered.

## Decision

We will record an estimated volumetric entry as **SNOMED CT `414135002` |Estimated (qualifier value)|** in `Observation.method`, published from `packages/core`'s `ESTIMATION_METHOD_CODE`.

We will **keep `null` as the representation of a measured entry** on the wire and in storage, and continue to reject every other non-null `method` value with `PAYLOAD_FIELD_INVALID` — including SNOMED CT `258104002` |Measured (qualifier value)|, which is a real concept this system deliberately does not transmit today.

> **Superseded by the amendment below, 2026-09-18.** `258104002` is now written for every measured volumetric entry. The paragraph above is kept rather than rewritten, because the reasoning it records is what the amendment had to overturn.

## Consequences

**What this gets us.** The Estimated half of a mandatory toggle can be saved, which the sprint that shipped the toggle could not do. Estimated entries are distinguishable from measured ones in storage, which is what AC 2.2 AC2 requires of the history view. The change was one line in one package: the API's `interpretMethodWireValue` reads the constant rather than a copy, so no server code needed editing, and three deliberate trip-wire tests failed on resolution and were replaced with assertions of the new behaviour rather than silently switching on.

**What this costs.** The value is now load-bearing in stored data. **Changing it later is a data migration, not an edit** — rows already written keep the old code, nothing detects the disagreement, and it surfaces at FHIR export or EHR integration. That is precisely the failure D4's caution was protecting against, now accepted deliberately rather than by accident.

A smaller cost, worth naming: `414135002` is a **qualifier value**, while the SRS and several code comments call this the "Estimation technique" code. FHIR's `Observation.method` is a `CodeableConcept` with no binding that forbids a qualifier, and what the field records is how the number was arrived at — which is what the qualifier says. The wording elsewhere is the informal name of the decision, not a constraint on the concept.

**What it forecloses.** Nothing structurally: `ESTIMATION_METHOD_CODE` stays a discriminated union, so the shape is still there for the next unresolved terminology code (voided-urine colour at P3.S2, the resting-conditions flag at P7), and the same trip-wire-test discipline applies to those.

### What this does not change, and the argument for revisiting it

`method: null` today carries **two different meanings**, distinguished only by the row's `code`:

1. a volumetric entry that was **measured**, and
2. a **weight** entry, where CLAUDE.md says the toggle does not apply and `method` is left unpopulated.

That inference is sound inside this system and **invisible outside it**. An exported FHIR `Observation` with no `method` says *not stated* — it does not say *measured*. A receiving EHR cannot tell a measured stoma-output entry from one written by a client that never implemented the toggle. Adopting `258104002` |Measured (qualifier value)| for case 1 would make the distinction data rather than inference, and would leave `null` meaning only "does not apply".

It is **not adopted here** because it is a different decision with a different blast radius: it changes what `method: null` means on a governing wire contract (`docs/sync-contract.md` §7.2), requires the server to accept a second code, and touches both clients. Under §8 it is additive-ish today and a versioned, coordinated-release change once clients ship — so it is **free now and expensive for the rest of v1**, which is the same shape of argument §5.4 makes about `CURSOR_TOO_OLD`.

Recorded here rather than left implicit so that whoever builds the FHIR export module (P5) does not rediscover it from scratch, and so the question is answered on purpose rather than by default.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Keep D4 open and ship Measured-only | Violates AC 2.2 AC1's mandatory toggle. A patient who estimated would have to claim they measured, which puts false data in a clinical record — strictly worse than a screen that says the option is unavailable. |
| Invent a plausible-looking code | Explicitly forbidden by `packages/core`'s own comment and by the plan's D4 entry. A wrong code is durable, silent, and only surfaces after many rows carry it. |
| Store the toggle in a separate boolean column alongside `method` | A second source of truth for one fact, and it abandons the FHIR-shaped schema decision (SRS §4) for the one field FHIR actually defines for this. The two would drift. |
| Adopt `258104002` for measured in the same change | A larger, separable decision touching the governing wire contract and both clients. Folding it in would have meant making it without deciding it. See "What this does not change" above. |
| Treat an absent `method` key as measured | Already rejected in `docs/sync-contract.md` §7.2: an absent key is indistinguishable from a client that does not implement the toggle, which is why `null` must be explicit. |

## Spec impact

**Spec update required.**

- `docs/sync-contract.md` §7.2 — `method` now names the resolved code; §10's open-questions entry is marked resolved and gains the `258104002` question as a new open item.
- `design-specs/data-model/fhir-rxnorm-integration.md` — the open question moves to a recorded resolution.
- `CLAUDE.md` — the "Data model rules that are easy to get wrong" bullet names the code, and the `packages/core` paragraph no longer describes `ESTIMATION_METHOD_CODE` as unresolved.
- `SRS_v2.md` §4.4 / AC 2.5 AC2 describe the field, not the code value, and need no change.


## Amendment (2026-09-18): adopt `258104002` |Measured|

The open question this ADR recorded — whether `null` should become an explicit |Measured| code — is **resolved: adopted.**

### What changes

A measured volumetric entry is stored as SNOMED CT **`258104002` |Measured (qualifier value)|**, published from `packages/core`'s new `MEASURED_METHOD_CODE`, which carries the same discriminated-union shape as `ESTIMATION_METHOD_CODE` for the same reason. The two are a pair: a release that resolved one and not the other would write rows where `null` again means two things, which is exactly the state this amendment ends.

`method: null` **at rest** now means one thing only: this observation has no Measured/Estimated toggle — weight (LOINC 29463-7) and resting heart rate (8867-4). Asserting "Measured" about a number read off a scale would record a choice the patient was never asked to make.

`method: null` **on the wire** is still accepted, and still means measured. §8 requires the server to keep understanding a client built before this amendment, and refusing `null` would reject a correct entry from an app the patient has simply not updated — which §9 then tells that client to re-push indefinitely. The server normalises it to `258104002` before storing, so the wire may be imprecise while no stored row is.

### Why now rather than never

The original reasoning was that the inference — `method IS NULL` plus a volumetric `code` means measured — is sound inside this system. It is. The problem is that it is **invisible outside** it: an exported FHIR `Observation` with no `method` says *not stated*, not *measured*, and a receiving EHR cannot tell a measured stoma-output entry from one written by a client that never implemented the toggle. AC 2.2 AC2's history badge had the same shape of problem in miniature — it had to consult `code` to render a property of the entry.

The cost of adopting is a backfill migration, and that cost only grows. Doing it while the row count is small is the cheapest this will ever be.

### The backfill, and why it is sound rather than a guess

`20260918120000_adopt_measured_snomed_code` sets `method = '258104002'` where `method IS NULL` **and** `code` is one of the volumetric LOINC codes.

No row can be mislabelled by it. While D4 was unresolved the server refused every estimated entry outright with `PAYLOAD_FIELD_INVALID`, so a NULL `method` on a volumetric row can only ever have been a genuine Measured answer. That is what makes the backfill a restatement of an existing fact rather than an assumption about one.

It is scoped by `code` rather than by `method IS NULL` alone even though every accepted code today is volumetric, because the unscoped form stops being correct the moment weight or heart rate lands (P5–P7) and this migration is re-run against a restored database or copied as a template. The failure it would cause — asserting a patient chose "Measured" for a scale reading — is indistinguishable afterwards from a real answer.

### What it costs

A second value is now load-bearing in stored data, with the same warning as the first: changing it is a data migration, not an edit.

Clients that send `null` are now producing a row whose stored `method` differs from what they sent. That is deliberate and documented in §7.2, but it does mean a device's local row and the server's can disagree about the same entry until the client is updated — which is why `apps/mobile` was changed in the same PR to send the explicit code.
