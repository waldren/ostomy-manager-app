# ADR-0013: Close the delta cursor's visibility gap by withholding the in-flight transaction window

- **Status:** Accepted
- **Date:** 2026-09-11
- **Deciders:** Steven Waldren (chosen from the three candidates `docs/sync-contract.md` §5.3 lists)
- **Related:** [ADR-0001](0001-sync-contract-and-conflict-semantics.md) · `docs/sync-contract.md` §5.3 · SRS_v2 §4.5 · P2.S1b

## Context

ADR-0001 chose a monotonic server sequence over an `updated_at` timestamp for the delta cursor, and `docs/sync-contract.md` §5.3 states the invariant that choice exists to provide:

> If a client's cursor is `C`, the client has been shown **every** change for that patient with server sequence ≤ `C`. No row is ever skipped.

**That invariant does not hold for free, and §5.3 says so explicitly** — it names the hazard, declines to pick a mechanism, and makes choosing one an obligation on P2.S1b. This ADR records the choice.

The hazard is that PostgreSQL sequences are non-transactional. `nextval` is consumed before commit, and transactions commit in an order that need not match the values they took. A reader can see sequence 48214 committed while 48213 is still in flight. A client handed `cursor: "48214"` will never ask for 48213 again, and that row becomes **silently and permanently invisible** to that device — no error, no retry, and no way for either side to detect it afterwards.

This was reproduced against real PostgreSQL before any code was written, and again in-repo as `sync.integration.spec.ts`'s "§5.3 — the cursor guarantee under out-of-order commits". Two concurrent inserts where transaction A takes the lower sequence and commits second:

| Read, while A is in flight | Returns |
| --- | --- |
| naive `ORDER BY server_sequence` | B only — the client's cursor advances past A, permanently |
| `WHERE xmin < pg_snapshot_xmin(pg_current_snapshot())` | nothing |
| the same filter, after A commits | A, B — in sequence order |

**Why close it now rather than watch it.** For v1 the exposure is narrow: `apps/mobile` is the only writer and one patient's writes come from one device. It is not zero — the same patient on a second device, a `packages/seed` bulk load, and any future server-side write all produce it — and it is invisible when it happens. A defect that silently drops a clinical row and leaves no trace is not one to discover from a support ticket.

Settled already and not reopened here: the monotonic sequence itself (ADR-0001), the cursor's exclusive-lower-bound semantics, and the rule that a client may advance its cursor only from a delta response and never from a push receipt (§3.6).

## Decision

We will serve a delta row **only once its assigning transaction is known to have completed**, by filtering on PostgreSQL's `xmin` system column against the current snapshot's `xmin`:

```sql
AND xmin::text::bigint < pg_snapshot_xmin(pg_current_snapshot())::text::bigint
```

Every transaction with an id below the current snapshot's `xmin` has finished, so no row it wrote can still be pending — and, critically, no *lower* sequence can still arrive behind a row that is served. Rows from the in-flight era are withheld as a group rather than judged individually, which is why the filter is sound even though transaction-id order and sequence order are not guaranteed to agree in general.

This is §5.3's option 1. No schema change; the global `sync_sequence` and the triggers P1.S3 built and tested are unchanged.

The predicate lives in `apps/api/src/sync/sync-delta.service.ts`, in raw SQL because Prisma's typed API cannot express a system column. It selects only the ids of servable rows; the rows themselves are then fetched through the typed client, so nothing downstream is hand-mapped out of snake_case.

## Consequences

**What this gets us.** §5.3's invariant becomes true rather than aspirational, at the cost of one predicate. The mechanism is invisible to the wire contract — a client cannot tell it is there, which means it can be replaced later without a protocol version bump if a better option appears. And it is covered by a test that has been **mutation-checked**: removing the predicate makes that test fail exactly as the hazard predicts, so it cannot rot into a test that passes for unrelated reasons.

**What this costs.** Two things, both liveness rather than correctness — rows are delayed, never skipped.

1. **A just-written row may need one more poll to appear.** Harmless in this system: §9.5 already forbids a client confirming a save from a network response, and the local write is the confirmation (SRS §4.5). Sync is invisible to the patient except when it produces something to correct.

2. **`pg_snapshot_xmin` is held back by _any_ long-running transaction in the database, not only writers to these tables.** A long analytics query, a `packages/seed` bulk load, or a forgotten open transaction in a psql session stalls delta for every patient until it finishes. This is the cost worth knowing about, because the symptom — "sync stopped advancing" — does not point at its cause. It is the first thing to check if that is ever reported, and it is recorded in the service's own doc comment for that reason.

**What it forecloses.** Nothing at the protocol level. At the database level it couples delta liveness to global transaction hygiene, which becomes more of a constraint as more workloads share the instance. If that becomes painful — a reporting replica would not help, since the stall is driven by the primary's snapshot — the escape is §5.3's option 2 below, and switching is a schema migration plus a rewrite of one query, not a wire change. We would find out through the stall symptom, not through data loss.

## Alternatives considered

| Alternative | Why not |
| --- | --- |
| **Per-patient counter row, taken with `SELECT … FOR UPDATE`** (§5.3 option 2) | Makes assignment order equal commit order by construction, because one patient's writes serialize — and it is immune to the long-running-transaction stall above. It also closes a minor disclosure as a side effect: a global sequence means the gaps between a patient's consecutive values reveal how many writes every *other* patient made in between (aggregate activity volume, not a health fact about an identified person, so a tiebreaker rather than a reason). Declined for this sprint because it costs a schema migration, adds a per-patient write lock on every synced write, replaces machinery P1.S3 already built and tested, and gives up the global sequence's cross-patient ordering — which nothing currently reads. **This is the designated escape hatch** if the stall cost above ever bites. |
| **Bounded lag** — withhold rows within a small window of the maximum sequence (§5.3 option 3) | §5.3 rules it out by name and the reasoning is right: it narrows the race rather than closing it, and it fails exactly under the load that makes the race likely. It is listed in the contract specifically because it is the option that looks sufficient under a test that does not interleave — which is precisely the test this sprint was required to write. |
| **Leave the gap and monitor** | There is nothing to monitor. The failure is a row that one device never sees; the server has no signal, the client has no signal, and the patient's data simply differs between devices. Detection would require comparing full row sets across devices, which nothing does. |
| **Switch the cursor to `updated_at`** | The problem ADR-0001 chose the sequence to avoid. Timestamps collide, go backwards under NTP correction, and have worse ordering guarantees than the sequence does even with this hazard present. |
