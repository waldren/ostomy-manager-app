# ADR-0019: Allow five minutes of client clock skew on a synced operation

- **Status:** Accepted
- **Date:** 2026-09-18
- **Deciders:** Steven Waldren
- **Related:** `docs/sync-contract.md` §3.8 | [ADR-0001](0001-sync-wire-contract.md) | [ADR-0016](0016-patient-local-day.md) | SRS_v2 §3.8

## Context

`docs/sync-contract.md` §3.8 requires the server to refuse a pushed operation whose `clientTimestamp` is implausibly far in the future, with `CLIENT_TIMESTAMP_OUT_OF_RANGE`. The rule exists because last-write-wins resolves by client timestamp (§4): a device with a badly wrong clock does not merely record a wrong time on its own entry, it **wins every conflict against every other device, indefinitely**, and the losing versions go to the audit log rather than to the patient's screen. Ordering is the thing being protected, not the displayed time.

The contract deliberately does not name the allowance. P2.S4 seeded `validation_thresholds.sync_clock_skew_allowance_seconds = 300` so the surface would work, and that value was chosen by the engineer implementing it with no stated basis. It has been carried on the open-questions list since, precisely because a number nobody decided is indistinguishable in code from a number somebody did.

Two things narrow the choice more than they first appear:

- **A phone's clock is not usually wrong.** Both mobile platforms sync time from the network by default. The realistic failure is not drift; it is a device with time sync disabled, a manually set clock, or a timezone/DST bug — and those are usually wrong by hours, not minutes.
- **The cost of being too strict is a hard block on a real entry.** Tier 1 blocks are structural refusals with no override (CLAUDE.md), and this one lands on a patient who did nothing wrong and cannot diagnose it. That is the expensive direction.

## Decision

Keep **300 seconds (five minutes)** as the allowance, and record it here so it stops being an unexplained constant.

It stays what it already is: a row in `validation_thresholds`, admin-adjustable without a release, `patient_adjustable = FALSE`. This ADR fixes the **default and the reasoning**, not the mechanism.

## Consequences

**Why five minutes is the right shape of number.** It is comfortably wider than any clock error a network-synced device produces, and comfortably narrower than the hours-scale errors that actually occur when time sync is off. Widening it does not make those cases pass — a clock wrong by three hours is refused at five minutes and at fifteen alike — so the extra tolerance buys nothing while weakening the ordering guarantee for the case it does admit.

**What it does not protect.** This bounds the future only. A clock running *behind* produces an entry that loses conflicts it should win, and §3.8 does not refuse it — refusing backdated timestamps would make a genuine offline backlog unpushable, which is the whole point of the queue. So a slow clock is a real and unhandled failure mode; it is simply the less damaging one, because a losing write is preserved in the audit log while a spuriously winning write silently overwrites.

**What a patient sees when it fires.** A rejected operation goes to the correction inbox (§9.1) describing a problem the patient cannot fix — their clock is wrong, and the entry form has no clock field. That is a known rough edge of this rule rather than a consequence of the specific value, and it is the argument for keeping the allowance generous enough that it fires only on genuinely broken clocks.

**Revisit it if** telemetry ever shows `CLIENT_TIMESTAMP_OUT_OF_RANGE` occurring at any real rate. That would mean the assumption above — that network time sync is the norm — is wrong for this population, and the right response would be to handle the wrong-clock case properly (detect skew at sign-in, offer to correct it) rather than to widen a threshold until the symptom stops.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Leave it as unexplained configuration | It is already configuration, which is what CLAUDE.md requires of a threshold. What was missing is the reasoning — and an undocumented default is one a future contributor either re-litigates or changes without knowing what it protects. |
| Widen to 15–60 minutes | Buys no additional real-world passes, since the failures that occur are hours-scale, and weakens §4's ordering guarantee for the window it does admit. |
| Derive it per device from an observed offset | Requires a trusted server-time exchange this protocol does not have, and makes the bound depend on the very clock it is checking. |
| Refuse backdated timestamps too | Would make a legitimate offline backlog unpushable — the queue exists precisely to hold entries written hours or days before they sync. |
