# ADR-0016: A "day" is the patient's local day, captured at write time

- **Status:** Accepted
- **Date:** 2026-09-13
- **Deciders:** Steven Waldren
- **Related:** SRS_v2 §3.5, §3.7, §3.12 | [ADR-0012](0012-entered-measurement-system-provenance.md) | [ADR-0004](0004-canonical-units.md) | `docs/sync-contract.md` §7.2

## Context

"Daily Net Fluid Balance" is the headline hydration signal (SRS_v2 §3.5), "daily totals" drive anomaly highlighting against physician-set ranges (§3.9), and the patient dashboard's composite status is computed per day (§3.12). The spec uses the word *daily* throughout and **never defines where a day starts**.

Nothing in the system supplies that definition either. `observations.effective_datetime` is `Timestamptz(3)` — an instant, with no offset or zone retained. `packages/core`'s formatters pin `timeZone: 'UTC'`, `apps/web` builds its query window as `T00:00:00.000Z` to `T23:59:59.999Z`, and its chart positions bars by `getUTCHours()`. The whole client is internally consistent and anchored to UTC.

The consequence for a patient west of Greenwich: at UTC-6, everything logged after 6pm local counts toward the next day. A high-output ileostomy patient's evening output — the clinically interesting part, and the reason overnight dehydration is a risk — is split across two "days" that neither the patient nor their clinician would recognise as days. The app's "today" and the patient's own sense of today never agree.

This is not a display bug. It changes which entries are summed into a clinical figure, and P3/P6 are about to compute those figures server-side.

There is an exact precedent for the shape of this problem. ADR-0012 requires every observation to carry the **entered measurement system**, resolved at write time and never re-derived, because the patient's profile is mutable and deriving it later is wrong precisely for the patients who changed. Timezone is structurally identical: patients travel, and patients relocate.

## Decision

We will define a day as **the patient's local calendar day at the moment of entry**, captured from the device at write time and stored per observation. We will never derive it from a mutable profile field or from the reader's timezone.

Each observation gains two columns:

- `entered_timezone` — the IANA zone name the device reported (`America/Chicago`), `NOT NULL` with no default, client-asserted exactly as `entered_measurement_system` is.
- `local_date` — the calendar date that instant fell on in that zone, derived once at write time, `NOT NULL`, indexed.

Daily aggregates `GROUP BY local_date`. The stored instant remains the single source of truth for ordering, sync, and last-write-wins; `local_date` is a derived grouping key, never an ordering key.

The zone travels on the sync wire as a required field on every observation operation, and `docs/sync-contract.md` — which governs — is amended in the same change. The server validates that the value is a resolvable IANA identifier and rejects the operation as Tier 1 if not; it does not second-guess *which* zone, for the same reason it does not second-guess the measurement system.

## Consequences

**What this gets us.** A daily total contains the entries the patient made that day, by their own reckoning. A patient who flies to Berlin keeps Monday's entries on Monday. A patient who relocates permanently does not see last year's history silently regrouped. And because the zone is captured rather than looked up, the grouping is reproducible years later from the row alone.

**What this costs.**

*A migration, and a wire-contract amendment.* `docs/sync-contract.md` is normative, so this touches the one document that governs the offline path. Both clients must send the zone; a client that does not is rejected.

*Two days can hold the same instant.* For a patient who crosses a timezone, `local_date` is not monotonic with `effective_datetime`, and a day can contain 23 or 25 hours. Any code that assumes a day is exactly 24 hours, or that sorting by `local_date` matches sorting by instant, is wrong. This is inherent to the decision rather than a defect of it.

*DST.* An IANA zone plus the instant resolves DST correctly; a fixed UTC offset would not, which is why the zone name is stored rather than an offset.

**What it forecloses.** Once real observations exist, `local_date` cannot be recovered for rows written without it — the instant alone does not say where the patient was. This is the same permanence ADR-0012 describes, and it is why the decision is made now, with no production data, rather than when the first daily total looks wrong.

**What it does not decide.** Whether the physician view renders in the patient's zone or the reader's. The *grouping* is the patient's; the *rendering* of an individual timestamp is a presentation question, and the current UTC-with-explicit-zone-label rendering is safe until it is answered.

## Alternatives considered

| Alternative | Why not |
|---|---|
| A single timezone on the patient profile | The mutable-profile trap ADR-0012 was written about. Editing it retroactively changes what every past day contained, and a travelling patient's entries land on the wrong day while away. |
| The reader's browser timezone, at render | A physician and their patient would see different day groupings of the same data, and the same export would total differently depending on who opened it. |
| Keep UTC and label it | Honest, and cheap. But it makes the app's primary clinical aggregate disagree with the patient's day for most of the world's population, and the fix gets impossible once rows exist. |
| Store a fixed UTC offset instead of an IANA zone | Ambiguous across DST: `-05:00` does not say whether the next entry should be `-05:00` or `-06:00`, so the grouping breaks twice a year. |
| Derive `local_date` at read time from the stored zone | Works, and avoids a column — but makes every daily aggregate a per-row computation the database cannot index, on the query that runs most. |
