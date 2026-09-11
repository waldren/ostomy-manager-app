# ADR-0012: Store the entered measurement system on every observation

- **Status:** Accepted
- **Date:** 2026-09-06
- **Deciders:** Steven Waldren (accepted from P1.S4 review)
- **Related:** **Completes [ADR-0005](0005-decimal-volumetric-entry-and-conversion-rounding.md)** (which remains Accepted) · [ADR-0004](0004-canonical-storage-units.md) · [ADR-0011](0011-database-roles-and-audit-immutability.md) · SRS_v2 §3.10, AC 2.1 AC 4

## Context

[ADR-0005](0005-decimal-volumetric-entry-and-conversion-rounding.md) defines conversion rounding in terms of the **entry** measurement system: a stored volume rendered in a system *other than the one it was entered in* is rounded to the nearest whole unit. Its worked example is explicit — 8 oz stored as 236.588 mL renders in metric as **237 mL**, not 236.588.

[ADR-0004](0004-canonical-storage-units.md) then made storage canonical mL and kg, and SRS §3.10 lets the patient change `Profile.measurementSystem` at any time. Between them, **nothing recorded which system a given row was entered in**, so ADR-0005's rule had no source of truth and was unimplementable as written.

P1.S4 shipped an approximation — "metric never rounds, imperial always rounds" — which review found broken in both directions: 8.5 oz entered read back as **9 oz** (ADR-0005 says a value is displayed as entered), and 8 oz entered rendered as **236.588 mL**, the literal outcome the rule exists to prevent. The fix moved the entry system into a required parameter on `convertVolumeForDisplay`, which made `packages/core` correct and left the schema unable to supply it.

Zero clinical rows existed at the time of this decision. That is the only reason it is cheap.

## Decision

`observations` carries **`entered_measurement_system`**, a `NOT NULL` column using the existing `MeasurementSystem` enum (`METRIC` / `IMPERIAL`) — the same enum `profiles.measurement_system` uses.

Every write path resolves the patient's measurement system **at entry time** and stores it on the row. Never at render time: the whole point is that the profile value may have changed since.

> **Amendment (P2.S1a, 2026-09-10) — "entry time," not "write time."**
>
> As originally written this sentence said *write time*, and P2.S1a's first implementation read it literally: the server re-derived the value from `profiles.measurement_system` at the moment of the insert and refused any payload that disagreed. That is wrong for the offline client, and `docs/sync-contract.md` §7.2 already said so — "resolved from their profile at entry time **on the device**, never re-derived server-side from the current profile."
>
> The two readings coincide for an online write, where entry and write are the same moment, which is why the direct endpoint could not reveal the difference. They diverge exactly where this ADR's own invariant bites: a patient logs three days of entries offline in imperial, switches to metric, then reconnects. Re-deriving server-side attributes every queued row to a system the patient did not type in — and the refusal variant rejects them on a field no entry form contains and the patient cannot edit, using a reason code §6.2 does not define for that case, with §9 forbidding both dropping the operation and retrying it unchanged.
>
> **The client's asserted value governs.** The server validates only that it is one of the two enum members, which is the sole domain check §6.2 defines for this field. This is not a new position: the invariant below already states that the canonical value and the entry system together are "the only record of what the patient actually typed," and for a queued write the device is the only party that knows what that was. The original wording predates offline entry and was imprecise, not mistaken in intent.
>
> The concern this trades against — an untrusted device deciding how a row is rounded on display — is real but small and bounded: canonical storage is unaffected (always mL/kg per ADR-0004), and the blast radius of a lying client is display rounding on that client's own rows. Weighed against a class of permanently uncorrectable rejections for every patient who ever changes the setting, it is the better trade. `docs/sync-contract.md` governs per CLAUDE.md, and this amendment brings the ADR into line with it rather than the reverse.

**The system, not the unit.** A unit-level column (`mL`/`oz`/`kg`/`lb`) would store no fact this column plus `code` does not already determine — ADR-0004 fixes the code-to-canonical-unit mapping, and §3.10 makes mixed-system combinations unselectable. It would also need a second CHECK cross-validating unit against code. And `packages/core` consumes the system directly: `unitsForMeasurementSystem(system)` is the one function that turns this value into what `convertVolumeForDisplay` needs, so a write path reads the column and passes it straight through with no translation.

**`NOT NULL`, on every row, not only volumetric ones.** Converting *any* patient-entered value into canonical storage — a weight entered in pounds included — requires knowing the entry system to perform the conversion at all. Every write path therefore already holds this value at insert time regardless of observation code. `method` already carries a NULL that means two different things depending on the row; that is a wart the schema tolerates, not a pattern worth repeating.

## Consequences

**What this gets us.** ADR-0005's rule becomes implementable exactly as written, for both patient populations. A patient reads back their own entries unrounded in their own system, and sees a clean whole number when the display system differs. `packages/core`'s required `entrySystem` parameter gets a truthful source rather than a guess derived from a mutable profile field.

**What this costs.** Every observation write must supply it — a `NOT NULL` with no default is a compile-and-runtime obligation on P2.S1a, P2.S1b's sync path, and `packages/seed`. That friction is deliberate and of a piece with [ADR-0011](0011-database-roles-and-audit-immutability.md)'s explicit-grant model: a forgotten value fails loudly in development rather than silently defaulting to the wrong system.

**A new invariant, stated deliberately rather than discovered later.** The entered measurement system becomes a **permanent, unfixable-after-the-fact property of a row**, in the same category as `effectiveDatetime`. If a write path stores it wrongly, no later profile change or migration can recover the truth — the canonical value and the entry system together are the only record of what the patient actually typed. This is the price of making ADR-0005 implementable, and it is worth stating because it is the kind of invariant that gets violated by a well-meaning backfill.

**What it forecloses.** A future "same system, different unit" axis — UK versus US fluid ounces, both legitimately "imperial" — cannot be expressed by this column. Nothing in the SRS or any ADR anticipates that, and v1 is US-only, so it is recorded rather than designed for. It would need the unit-level column this decision declined.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Amend ADR-0005 to round **every** volume display, metric included | Needs no schema change and was seriously considered. Rejected because it destroys real entered precision for the common case: a metric patient who never switches systems would see their own mL entries rounded for no reason, which is a worse outcome than one small provenance column added while zero rows exist. |
| Store the entered **unit** rather than the system | Stores nothing the system plus `code` does not determine, and adds a cross-validating CHECK. Its only advantage is the foreclosed case above, which nothing requires. |
| Nullable column, with NULL meaning "assume the profile's current system" | Reintroduces exactly the bug this fixes — the profile is mutable, so the assumption is wrong precisely for the patients who switched. Also repeats `method`'s overloaded-NULL wart. |
| Derive it at render time from `Profile.measurementSystem` | What the code did implicitly before this decision, and the source of the defect. |
| Defer to P2 | The column is free at zero rows and a backfill with no source of truth afterwards. |

## Spec impact

**No spec change.** SRS AC 2.1 AC 4 already states the rule; this supplies the mechanism that makes it true. `CLAUDE.md` is updated, because "every observation write must supply the entered measurement system" is a rule a working session needs before writing an insert.

**This completes [ADR-0005](0005-decimal-volumetric-entry-and-conversion-rounding.md); it does not supersede it.** ADR-0005's decisions — decimal entry, display-only conversion rounding, the weight carve-out — all stand unchanged. Per `design-specs/decisions/README.md`, accepted ADRs are immutable, so ADR-0005 is not edited; this cross-reference lives here and in the index.

## Compliance and safety review

No PHI exposure and no new grant. Verified rather than assumed: `information_schema.role_table_grants` for `(ostomy_runtime, observations)` is unchanged before and after, because PostgreSQL's unqualified table-level grant covers columns added later by `ALTER TABLE … ADD COLUMN`. ADR-0011's "no blanket `ALTER DEFAULT PRIVILEGES`" concerns new **tables**, not new columns — a distinction worth recording, since assuming otherwise would have produced a redundant grant and assuming it in reverse would leave a future table ungranted.

The safety dimension is clinical accuracy rather than confidentiality: a wrong entry system silently misreports every converted volume for that row, and §3.12's weight-change detection depends on the same conversion path.

## Notes

Re-check at **P2.S1a**, the first real write path, and again at **P2.S4** when `packages/seed` must supply it for every generated row.

`design-specs/data-model/p1-s3-schema-coverage.md` — the P2.S1a handoff artifact — carries the obligation in full. `fhir-rxnorm-integration.md` records that this is app-native provenance rather than a FHIR element, and leaves open whether it should eventually surface as a non-standard `extension` on export.
