# ADR-0004: Store all volumes in millilitres and all weights in kilograms; convert only at render time

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Steven Waldren (accepted from implementation-planning recommendation)
- **Related:** SRS_v2 §3.0, §3.10, §3.12, §4.4 · [ADR-0005](0005-decimal-volumetric-entry-and-conversion-rounding.md)

## Context

SRS_v2 §3.10 settles that a single metric/imperial preference governs both volume and weight, that mixed-system combinations must be impossible to select, and — critically — that **stored canonical values are never rewritten when the preference changes**. What it never states is what "canonical" _is_.

That omission is invisible until rows exist, and permanent afterwards. If two clients disagree about the storage unit, or if the storage unit is taken from the patient's preference at write time, then a preference change silently reinterprets historical data: a 250 that meant millilitres becomes a 250 that means ounces. Nothing errors. The physician view simply shows a patient who drank eight litres.

The API, both clients, and the seed generator all write observations, and under [ADR-0007](0007-packages-core-ownership.md) they are built by different agents in different invocations. A convention that lives only in someone's memory will not hold.

Surfaced by implementation planning, before any row exists — which is the only cheap moment to decide it.

## Decision

We will store **millilitres for every volume and kilograms for every weight**, unconditionally, regardless of the patient's measurement-system preference. Imperial is a **render-time conversion only**.

We will also **persist the unit string on every row** (`observations.value_quantity_unit`), even though it is derivable from the column's canonical unit, because FHIR `valueQuantity.unit` requires it and because an explicitly stored unit makes a future misinterpretation recoverable rather than guesswork.

The canonical unit types will be defined in `packages/core` such that a mixed-system value is **unrepresentable in the type**, not merely unselectable in the UI.

## Consequences

**What this gets us.** Every aggregate — daily net fluid balance, rolling weight baseline, urine output totals — sums raw column values with no per-row unit inspection. Comparisons against admin-managed thresholds need no normalisation step, so a threshold cannot be accidentally compared against a value in the other system. A preference change becomes a pure display concern, satisfying §3.10 by construction rather than by discipline. And the FHIR export module has the units R4 expects without a conversion pass.

**What this costs.** Every imperial-preference patient sees converted numbers at every render, so conversion is on the hot path of every list, chart, and summary — and it is one more place a rounding rule ([ADR-0005](0005-decimal-volumetric-entry-and-conversion-rounding.md)) has to be applied consistently. An imperial patient who enters 8 oz and later reads the same entry back sees a rounded 237 mL round-tripped to 8 oz; the arithmetic is correct but the displayed value is not always byte-identical to what they typed. Storing a unit string that is always the same value is mild redundancy.

**What it forecloses.** Storing values in the patient's preferred unit becomes impossible without a full data migration touching every clinical row, and one that cannot be run safely against rows whose original unit is ambiguous. We would find out the first time a patient switches systems and their history shifts by a factor of 29.6 — which is to say, in production, reported by a patient.

## Alternatives considered

| Alternative                                                     | Why not                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Store in the patient's preferred unit, with the unit on the row | The intuitive option, and the one someone will re-propose because it means "no conversion for most users." It makes every aggregate unit-aware, so a single missed conversion in one aggregate silently corrupts a clinical figure. It also makes §3.10's "never rewritten" rule load-bearing in a way that is easy to violate during a preference change. |
| Store both canonical and display values                         | Doubles the columns and creates two sources of truth that can drift; a bug in the conversion writes a wrong value permanently rather than displaying one wrongly.                                                                                                                                                                                          |
| Ounces and pounds as canonical                                  | Defensible, but mL and kg are what LOINC, FHIR, and every clinical default range in §3.9 are expressed in. Choosing imperial would push conversion into the threshold tables and the export module instead — more surface, not less.                                                                                                                       |

## Spec impact

**No spec change.** This fills a gap in §3.10 rather than contradicting it, and it is what makes §3.10's "never rewritten" guarantee mechanically true. `CLAUDE.md` is updated, because the canonical unit is a rule working sessions need before writing any storage code.

## Compliance and safety review

Touches clinical data correctness rather than PHI exposure. The safety dimension is real: a unit misinterpretation is a silent clinical error, not a crash. The mitigation is the type-level one above — mixed-system states unrepresentable in `packages/core`, verified at P1.S4.

## Notes

Conversion factors and their rounding behaviour are specified in [ADR-0005](0005-decimal-volumetric-entry-and-conversion-rounding.md), not here.
