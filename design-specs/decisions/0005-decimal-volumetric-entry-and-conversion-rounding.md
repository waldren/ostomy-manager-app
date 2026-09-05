# ADR-0005: Accept decimal volumes on entry, and round to the nearest whole unit only when converting between measurement systems

- **Status:** Accepted
- **Date:** 2026-09-05
- **Deciders:** Steven Waldren (explicit ruling)
- **Related:** SRS_v2 §3.0, §3.10, §3.12, AC 2.1 AC 1, AC 2.1 AC 4, AC 17.1 AC 1 · [ADR-0004](0004-canonical-storage-units.md)

## Context

SRS_v2 AC 2.1 AC 1 was carried forward unchanged from v1.0 and required the output volume field to accept **"positive integers (no decimals or negative numbers)."** That criterion was written when the app was millilitre-only.

Phase 4 and Phase 5 made imperial a first-class measurement system (§3.0, §3.10), and the two rules cannot both hold:

- An ounce value is not naturally a whole number. Restricting an imperial patient to whole ounces is a coarser instrument than the same patient using millilitres, for no clinical reason.
- 2,000 mL — the Tier 2 soft-warning threshold in AC 2.1 AC 2 — is 67.6 oz, not a whole number of ounces. An integers-only imperial field cannot express the threshold it is validated against.
- Body weight already requires one decimal place (AC 17.1 AC 1, §3.12), so the spec was internally inconsistent about precision across entry types.

Surfaced by implementation planning as finding F2, and ruled on directly. It lands at P2.S2b, the first screen with a volume field, so it had to be settled before the first slice.

## Decision

**Entry.** The volume field accepts **positive decimal values**. It rejects negative numbers, zero, and non-numeric input (Tier 1 hard block, unchanged). Entry precision is not capped: it will never be coarser than a whole unit and may be finer.

**Storage.** The entered value is stored at its entered precision in the canonical unit ([ADR-0004](0004-canonical-storage-units.md)). Stored values are never rounded and never rewritten.

**Display in the entry system.** A value is displayed as entered.

**Display after conversion.** When a stored volume is rendered in a measurement system other than the one it was entered in, the converted result is **rounded to the nearest whole unit** (mL or oz). This is a presentation rule only; it never writes back.

**Weight is excluded from the whole-unit rounding rule.** Converted weights are displayed to **one decimal place** in both systems, per the existing AC 17.1 AC 1 and §3.12.

## Consequences

**What this gets us.** Imperial and metric patients get equal precision. The Tier 2 threshold is expressible in both systems. Volume displays stay readable — a converted 8 oz reads as `237 mL`, not `236.588 mL` — which matters for a patient population that skews older and post-surgical, where a wall of decimal noise is a genuine usability cost. And because rounding is display-only, no precision is ever lost from the record the care team sees.

**What this costs.** A converted value does not round-trip to the digits the patient typed: 8 oz stored as 236.588 mL and rendered back to imperial reads as 8 oz, but rendered in metric reads as 237 mL, and a patient switching systems twice may notice the display shift by a fraction. Daily totals computed from canonical values will also not always equal the sum of the rounded per-entry figures shown on screen — a classic rounding-visible-in-the-UI problem that the physician view must handle by rounding the total independently rather than summing rounded parts.

**What it forecloses.** Reverting to integers-only would now be a breaking change for stored data. Nothing else — the rule is presentational, so it can be tightened or loosened later without a migration.

## The weight carve-out, stated plainly

The ruling as given was "round the result to nearest integer" for conversion. Applied literally to body weight, that would be actively harmful, so it is scoped to volume:

§3.12 detects dehydration from **day-over-day weight change**, and Tier 2 flags an implausible change between consecutive readings. Rounding a converted weight to a whole kilogram or pound discards every change smaller than 1 kg (2.2 lb). A 0.9 kg overnight drop — a clinically meaningful fluid loss in an ileostomy patient, and precisely what the weight signal exists to catch — would render as no change at all. The signal would be silently destroyed at the display layer while the underlying data remained correct.

Weight therefore keeps its existing one-decimal-place rule in both systems. This is a scoping judgement made inside the ruling, not a departure from it; if whole-unit weight display is genuinely wanted, it should supersede this ADR explicitly.

## Alternatives considered

| Alternative                                                      | Why not                                                                                                                                   |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Keep integers-only, metric-only                                  | Would require dropping imperial as a first-class system, which §3.0 and §3.10 settle.                                                     |
| Integers in canonical storage, decimals only in imperial display | Caps metric precision at 1 mL while allowing finer imperial input — the inconsistency inverted rather than fixed.                         |
| Decimals everywhere, no display rounding                         | Shows `236.588 mL` to a patient. Correct and unreadable; the accessibility and plain-language requirements in §5.4 weigh against it.      |
| Round on write instead of on display                             | Loses real entered precision permanently, and makes the stored value depend on the preference active at write time — which §3.10 forbids. |

## Spec impact

**Spec update required, and applied in the same change (SRS_v2 v2.4):**

- **AC 2.1 AC 1** rewritten from "positive integers" to positive decimal values, with a note recording why.
- **AC 2.1 AC 4 (new)** added, specifying conversion rounding and the weight exclusion.
- Header changelog updated; document version bumped to v2.4.
- `CLAUDE.md` updated, since precision and rounding are rules a working session needs before writing any volume field or conversion helper.

Existing AC IDs were not renumbered — §3.11 notes that engineering documentation references them, and renumbering would silently invalidate those references.

## Compliance and safety review

No PHI or audit dimension. There is a patient-safety dimension, addressed above: the weight carve-out exists specifically to prevent a display rule from suppressing a dehydration signal. `accessibility-copy-reviewer` should confirm at P2.S2b that the decimal field remains usable with assistive technology and at large text sizes, and at P6.S2 that weight change is still presented in absolute terms.

## Notes

Conversion factors, and whether rounding is half-up or half-to-even, are implementation details for `packages/core/src/units` — but they must be defined once there and used by every client, not re-derived per app.
