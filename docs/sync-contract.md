# Sync wire contract

**Status:** Normative. This document is the authoritative reference for the offline sync wire format. It implements [ADR-0001](../design-specs/decisions/0001-sync-contract-and-conflict-semantics.md) and is bound by SRS_v2 §3.6, §3.8, §4.5, §5.3 and AC 13.1.

**Scope.** The wire format only: request and response shapes, ordering, idempotency, conflict resolution, tombstones, the delta cursor, and the error taxonomy. It does not describe the mobile client's local queue schema (`apps/mobile`, P2.S2) or the server's handler structure (`apps/api`, P2.S1b). It describes what crosses the network between them, which is the part neither side may change unilaterally.

**Who this binds.** `apps/mobile` is the only sync client — `apps/web` is online-only by explicit decision (SRS §4.3) and never speaks this protocol. The types are in `packages/core/src/sync`, owned by `nestjs-api-developer` under [ADR-0007](../design-specs/decisions/0007-packages-core-ownership.md).

**This document governs.** Where it and the types disagree, **the types are wrong** and are corrected to match — a type can be regenerated and a fielded app cannot. The one exception runs the other way: if this document states something unimplementable or internally contradictory, the fix is to correct the document, never for an implementation to quietly deviate from it. A contract two implementers read differently has already failed, whichever of them was right.

**Why it is written before any sync code.** Once mobile clients are in the field the wire format is effectively frozen: changing it needs a coordinated server and app-store release, and old app versions keep speaking the old contract for as long as users decline to update. Every cost recorded here is a cost paid once now instead of forever later.

---

## 1. Terms

| Term | Meaning |
| --- | --- |
| **Operation** | One local write the client made while it was the only authority for it: a create, an update, or a delete of one entity. The unit of idempotency, of ordering, and of accept/reject. |
| **Operation id** | A UUID the client generates **when the operation is enqueued**, not when it is pushed. Never the entity id. |
| **Entity id** | The UUID of the row the operation acts on. Client-generated at create time — the server does not mint entity ids (`Observation.id` has no database default, deliberately). Stable across every later update of that row. |
| **Client timestamp** | The client's wall-clock reading of when the *write* was made. Orders a batch and decides last-write-wins. Distinct from `effectiveDateTime`, which is the clinical moment the observation describes. |
| **Server sequence** | A server-assigned, monotonically increasing integer stamped on every synced row. The delta cursor is a value of this. |
| **Tombstone** | A row with `deletedAt` set. Deletes never remove rows. |

The distinction between **client timestamp** and **`effectiveDateTime`** is load-bearing and easy to collapse. A patient can log at 22:00 an emptying that happened at 14:00; the client timestamp is 22:00 and the effective date-time is 14:00. Conflict resolution uses the first. Clinical display, ordering in history, and Daily Net Fluid Balance use the second.

---

## 2. Transport and authentication

Both endpoints sit under the patient API surface at `/api/v1/sync/...` and require a patient access token, verified by `JwtAuthGuard`. Neither has any admin analogue.

**The patient is derived from the token, never from the payload.** There is no patient identifier anywhere in a request body or query string, and the server MUST NOT accept one. This is not defense in depth — it is the absence of the field that could carry the attack. A request that reaches the handler acts on exactly one patient: the subject of the presented token.

**Every entity lookup is scoped to that patient.** Without exception, and in every code path: the create-collision check, the update target, the delete target, and the stored row a conflict is resolved against are all found by `(patient, entityId)` **together**, never by `entityId` alone. An entity id that resolves only to another patient's row is treated as not existing.

This is the same argument §3.7 makes for `operationId`, applied to the other client-chosen identifier, and it needs stating because the storage layer does not imply it: `Observation.id` is a global primary key, so `update({ where: { id } })` compiles, passes every test built from this document, and lets a token for patient A overwrite patient B's row given its UUID. That is authorization that proves only authentication.

**Decoding is whitelist-strict at every level** — request, operation, and payload. A key not named in this document is rejected, never ignored and never passed through. The TypeScript types have no `patientId` property, but a type does not exist at the JSON decode boundary; the parser is what enforces this, and for `apps/api` that means a `ValidationPipe` with `whitelist: true` and `forbidNonWhitelisted: true`, not the type alone. An extra key at the request or operation level is `MALFORMED_REQUEST` (§6.1); an extra key inside a payload is `PAYLOAD_FIELD_UNRECOGNIZED` (§6.2), because only the second is something a newer client might have meant to send.

**Both endpoints are rate-limited**, and a `since=0` delta pull is recorded in the security log. `since=0` returns a patient's entire clinical history in pages; it is legitimate exactly at install and reinstall, and it is also what a stolen token is worth. A read is not an SRS §5.2 audit event and does not belong in `audit_events` — this goes to the application security log, which is where the question "did a bulk export happen, and when" has to be answerable from, because that is the determination the breach-notification clock runs on.

Every payload arriving here is untrusted input from a device that may have been offline for days, may be running an old app version, and may be lying. Client-side validation is a UX affordance only (SRS §3.8). Every rule is re-enforced here.

---

## 3. `POST /api/v1/sync/push`

### 3.1 Request

```json
{
  "operations": [
    {
      "operationId": "0f9c3b4e-6a2d-4c1b-9f3a-1d2e3f4a5b6c",
      "entityType": "Observation",
      "entityId": "7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d",
      "operationType": "create",
      "clientTimestamp": "2026-09-07T22:04:11.412Z",
      "payload": {
        "resourceType": "Observation",
        "id": "7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d",
        "status": "final",
        "code": "79560-9",
        "valueQuantity": { "value": 350, "unit": "mL" },
        "effectiveDateTime": "2026-09-07T14:00:00.000Z",
        "method": null,
        "enteredMeasurementSystem": "metric"
      }
    }
  ]
}
```

`payload` is **absent** for `operationType: "delete"` and **required** otherwise.

### 3.2 Ordering

Operations are applied **in array order**, and the array MUST be non-descending in `clientTimestamp`. The server does not reorder (ADR-0001 point 6): last-write-wins is defined by client timestamp, so reordering would silently change which version wins.

Equal timestamps are permitted and resolved by array order — the client queued them in that order and is the only authority on it.

A descending array is a **protocol error** (§6.1), not a per-operation rejection: the server cannot repair it, because reordering is exactly what it is forbidden to do, and there is nothing a patient could correct.

**The constraint is per-request, and a descending local queue is not necessarily a client bug.** A user correcting their phone's clock, or an NTP correction after a cold boot, produces a locally correct queue that is descending across the discontinuity through no fault of the queue processor. The client's obligation is therefore not "never be descending" but **split the batch at each discontinuity and push the runs in order** — §3.3's splitting rule already preserves order across a split, and a single-operation batch is trivially non-descending. Without this stated, the §3.2 ordering rule, §9.6's ban on reordering, and §6.1's ban on retrying a `400` unchanged are jointly unsatisfiable, and a patient's entire offline backlog is stuck behind a clock correction they cannot undo.

### 3.3 Size

At most `SYNC_PUSH_MAX_OPERATIONS` operations per request (default 500, environment configuration). This is a transport bound, not a clinical one, so it is ordinary configuration and not a `validation_thresholds` row. Exceeding it is a protocol error returning `413`; the client splits the batch, preserving order across the split.

### 3.4 Response

`200 OK`, one result per operation, in request order:

```json
{
  "results": [
    {
      "operationId": "0f9c3b4e-6a2d-4c1b-9f3a-1d2e3f4a5b6c",
      "status": "accepted",
      "entityId": "7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d",
      "appliedServerSequence": "48213",
      "replayed": false
    },
    {
      "operationId": "1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5e",
      "status": "rejected",
      "entityId": "8b2f3c4d-5e6f-4a7b-8c9d-1e2f3a4b5c6d",
      "reasonCode": "VALUE_NOT_POSITIVE",
      "field": "valueQuantity.value",
      "replayed": false
    },
    {
      "operationId": "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e",
      "status": "superseded",
      "entityId": "9c3f4d5e-6f7a-4b8c-9d0e-2f3a4b5c6d7e",
      "appliedServerSequence": "48198",
      "replayed": false
    }
  ]
}
```

A batch never fails as a unit for data reasons (ADR-0001 point 2). One implausible row — precisely the kind Tier 2 exists to let through — must not block every subsequent entry a patient made while offline.

### 3.5 The three result statuses

| `status` | Meaning | What the client does |
| --- | --- | --- |
| `accepted` | Applied. The row now reflects this operation. | Remove from the queue. |
| `superseded` | Valid, processed, **not applied** — a newer version of the same entity already exists (§4). | Remove from the queue. Not an error; nothing to correct. |
| `rejected` | Refused by server-side validation or authorization. | **Retain locally and surface for correction** (AC 13.1 AC4). Never drop, never silently retry unchanged. |

`superseded` exists because the alternative is worse in both directions. Reporting a lost write as `accepted` tells the client its version is live when it is not, so a subsequent read looks like data loss. Reporting it as `rejected` sends it to the correction inbox, where a patient is asked to fix an entry that was never wrong. It is a third outcome because it is a third thing.

> **Schema obligation, owed before P2.S1b.** `SyncOperationStatus` in `apps/api/prisma/schema.prisma` currently has two values, `ACCEPTED` and `REJECTED`. It needs an additive `SUPERSEDED`. That is a `fhir-data-modeler` migration and is cheap while the table is empty. Recording the status only on the wire and collapsing it to `ACCEPTED` in storage would leave "this operation lost a conflict" recoverable only by correlating against the audit log, which is exactly the kind of fact that should be a column.
>
> Two further column notes belong with it, since this is the handoff. `applied_server_sequence` is documented as "NULL when rejected", but §3.6 requires it on `superseded` results too, so the comment needs widening along with the enum. And `rejection_reason_code`/`rejection_field` are free text: the wire type closes the response, storage does not, so P2.S1b owes a test asserting every stored `rejection_field` is a member of the closed set — §3.7's byte-for-byte replay guarantee is served from those columns.

### 3.6 `appliedServerSequence` is a receipt, not a cursor

Present on `accepted` and `superseded` results; absent on `rejected`. It names the server sequence of the entity row as it stands after this operation was processed — for `superseded`, that is the winning row's sequence, not this operation's.

**A client MUST NOT use it to advance its delta cursor.** It reports where one row landed; a delta cursor asserts that *every* row up to that point has been seen (§5.3). Advancing from a push receipt skips every row written between the client's last delta pull and this batch, and it bypasses whatever visibility mechanism §5.3 obliges the delta endpoint to apply. The delta cursor comes from a delta response and from nowhere else.

### 3.7 Idempotency and replay

Idempotency is keyed on **`(patient, operationId)` together**, never on `operationId` alone. The operation id is chosen by an untrusted offline device and is not patient-scoped by construction: a buggy or malicious client could choose one that another patient's device already used, and a global uniqueness check would let patient A's write cause patient B's distinct push to be refused as a replay. The lookup is always by the pair.

A re-pushed operation returns **the result the first attempt produced**, byte-for-byte apart from `replayed: true`, and has no further effect. A replayed rejection is still a rejection; a replayed create makes no second row. This is what makes the "push, lose the connection before reading the response, push again" sequence safe, which is the ordinary case on a phone, not the exotic one.

Byte-for-byte means the stored record retains everything the first response carried — `status`, `reasonCode`, `field`, and `appliedServerSequence` — not merely enough to recompute a status.

**Processing one operation is atomic.** The entity write, its server-sequence assignment, its audit event, and the idempotency record commit together or not at all. If they do not, the interesting failure is not a lost write but a *silently duplicated* one: the entity commits, the idempotency record does not, the response is lost, the client re-pushes, and the replay is not recognised as one. Nothing downstream can detect that afterwards, because both rows are legitimate.

**Two operations in one batch may not share an `operationId`.** That is `MALFORMED_REQUEST` for the whole request, not a replay of the first — an id is minted once at enqueue (§9.7), so two in one batch means the queue is broken, and treating the second as a replay would silently discard a write the client believed it had sent.

`replayed` is diagnostic. It is always present. A client MUST NOT branch clinical behaviour on it.

### 3.8 Clock skew on `clientTimestamp`

An operation whose `clientTimestamp` is further in the future than the `sync_clock_skew_allowance_seconds` threshold allows is **rejected** with `CLIENT_TIMESTAMP_OUT_OF_RANGE`.

This is separate from the Tier 1 rule that blocks a future `effectiveDateTime` (`EFFECTIVE_DATE_TIME_IN_FUTURE`), and it exists for a different reason. `effectiveDateTime` in the future is a data-entry mistake. `clientTimestamp` in the future is a **poisoned timestamp**: because conflict resolution is last-write-wins by client timestamp, a device with a clock set to 2031 wins every conflict against every other device, permanently, for every entity it touches. Nothing else in the protocol bounds that.

The allowance is an admin-managed threshold (ADR-0001 point 5), read from `validation_thresholds` under the key `sync_clock_skew_allowance_seconds`, not a constant in code. `packages/core`'s `VolumetricValidationThresholds.maxClockSkewMs` is the same clinical quantity expressed in milliseconds; both derive from the one row.

There is no symmetric past bound. A device offline for three weeks legitimately pushes three-week-old timestamps, and that queue is exactly what must not be discarded.

**This rejection has a defined recovery, and it is not the correction inbox.** `clientTimestamp` is not a field a patient can edit — it is when the write happened — so a `CLIENT_TIMESTAMP_OUT_OF_RANGE` operation sitting in the correction inbox is uncorrectable by construction, and §9 forbids both dropping it and retrying it unchanged. The client instead **re-enqueues the operation as a new one**: a fresh `operationId`, the same entity id and payload, and `clientTimestamp` set to the corrected current clock. Note what that does to §4 — the write now carries a *later* timestamp than it originally did, so it may win a conflict it would previously have lost. That is the right trade: the alternative is honouring a timestamp the server has already determined is wrong.

---

## 4. Conflict resolution

Last-write-wins by client timestamp, applied server-side (SRS §4.5). The comparison is between the incoming operation's `clientTimestamp` and the stored row's `clientUpdatedAt`.

| Case | Outcome | The losing version |
| --- | --- | --- |
| Incoming is **newer** | Applied. Result `accepted`. | The **stored** version, as it was before the write, goes to the audit log. |
| Incoming is **older** | Not applied. Result `superseded`. | The **incoming** version goes to the audit log. |
| **Equal** | Applied. Result `accepted`. | The stored version goes to the audit log. |

Equal timestamps resolve in favour of the incoming operation deliberately. The alternative — refusing to apply — makes a legitimate correction made inside the same millisecond disappear with no signal, and ties are a millisecond-resolution artifact rather than a real simultaneity.

**Every operation type is resolved this way, including a create.** A create whose entity id already exists for this patient is **not** a rejection — it is an ordinary last-write-wins comparison against the stored row, with the same three outcomes.

An entity id that resolves only to **another patient's** row is the one case last-write-wins cannot resolve, and §2 already says what happens to it: it is *treated as not existing*. It takes the same path, and returns the same `ENTITY_NOT_FOUND`, as an id that exists for nobody.

> **Corrected at P2.S1b.** This paragraph previously reserved a distinct `ENTITY_ID_CONFLICT` for the cross-patient case while simultaneously claiming the refusal happened "without revealing that the row exists". Those cannot both be true: **a distinct code is itself the disclosure.** An authenticated patient could tell "this UUID belongs to someone else" from "no such row" — low practical exploitability at 122 bits of UUID, but observation ids are not secrets by design, and they appear in a shared device's local database, in support tickets, and in a reused handset's prior account.
>
> Resolved toward §2, matching the precedent the direct endpoints already set at P2.S1a, where returning a byte-identical refusal in both cases was chosen specifically because it is *structurally incapable* of leaking. The attempt is not lost: the server records it to the application security log, so the probe learns nothing and the operator still sees it.

This matters because the reachable case is not a client bug. The server applies a create, the response is lost, the client re-pushes — and if the idempotency record did not commit with the write (§3.7), that arrives as a create against an existing row. Rejecting it would put a correct entry in the correction inbox carrying a code §6.4 says must not be shown to the patient, describing a problem they cannot fix.

**A tombstoned row still exists** for the purposes of update, delete, and conflict resolution. `ENTITY_NOT_FOUND` means no row with that id exists for this patient at all — not that the row is tombstoned. The distinction is load-bearing: ADR-0001's own consequences section tells implementers that "every read path must filter" tombstones, and an implementer who applies that here returns `ENTITY_NOT_FOUND` for exactly the operation the resurrection rule below says must succeed. A patient who deletes an entry offline and then edits it before reconnecting would have the edit rejected, rendered as the generic "could not be saved", and forbidden by §9.2 from being retried unchanged — an entry that can never be corrected, which is AC 13.1 AC4's failure arriving through the back door.

Deletes participate like any other operation: a delete at T2 beats an update at T1, and an update at T2 beats a delete at T1, resurrecting the row by clearing `deletedAt`.

An update is a **full replacement** of the entity's fields, not a patch. Every payload field is required (§7.2) and the payload is the entity's new state in its entirety.

### 4.1 What must be audited, and per what

**The losing version is written to the audit log rather than discarded** (SRS §4.5, CLAUDE.md). This is not optional and not best-effort. It is the only reason last-write-wins is acceptable for clinical data at all: nothing a patient recorded is destroyed, it is moved somewhere append-only.

ADR-0001's compliance review names **two** paths that get missed when audit logging is added per-handler — the sync-applied write and the conflict loser. Both are stated here, because P1.S5's interceptor covers *routes*, and a push batch applying fifty operations is one route.

| Event | `reasonCode` | Carries |
| --- | --- | --- |
| Each operation whose result is `accepted` | `sync_applied` | The affected entity's id, before and after values, the actor, and the batch's correlation id. |
| Each operation whose result is `superseded` | `sync_conflict_loser` | The **incoming** version that lost. |
| Each `accepted` operation that displaced a stored version | `sync_conflict_loser` | The **stored** version as it was before the write. |

**A batch of N applied operations produces N `sync_applied` rows**, each naming its own entity — not one row naming the batch. A batch-level event satisfies a route-scoped trip-wire while making the only question that matters in a breach investigation — "what happened to this record?" — unanswerable for every write that arrived over sync, which on the only offline-capable client is most of them.

**A delete audits the entity's full pre-deletion state** as `beforeValue`, with `afterValue` null. The tombstone deliberately carries nothing on the wire (§5.2) precisely because the audit store carries everything; once the purge policy in §10 lands, that row is the only surviving copy of what was deleted.

All of these route through the same `AuditService` as a direct write, not a parallel path. **P2.S1b owes two count-equality tests:** `sync_applied` rows equals `accepted` results, and `sync_conflict_loser` rows equals conflicts resolved.

---

## 5. `GET /api/v1/sync/delta`

### 5.1 Request

```
GET /api/v1/sync/delta?since=48198&limit=200
```

| Parameter | | |
| --- | --- | --- |
| `since` | required | Server sequence, **exclusive**. `0` requests everything — the initial sync of a newly installed or reinstalled app. Absent or non-numeric is `MALFORMED_REQUEST`. Older than the tombstone purge horizon is `CURSOR_TOO_OLD` (§5.3). |
| `limit` | optional | Page size. Default and maximum are server configuration. A `limit` above the maximum is **clamped, not refused** — the client discovers the real page size from the response, and a `400` here would permanently brick any fielded client whose hardcoded page size the server later lowered. |

A `since` **higher than any sequence the server holds** returns `changes: []`, `hasMore: false`, and `cursor` echoing `since` unchanged. It is reachable through a device restore, a `dev-reset`, or a database restore from backup. The two tempting alternatives are both wrong: returning the server's maximum moves a client's cursor *backwards* into rows it has already applied, and returning `"0"` silently re-downloads the patient's entire history over cellular.

### 5.2 Response

```json
{
  "changes": [
    {
      "entityType": "Observation",
      "entityId": "7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d",
      "serverSequence": "48213",
      "deleted": false,
      "clientUpdatedAt": "2026-09-07T22:04:11.412Z",
      "payload": {
        "resourceType": "Observation",
        "id": "7a1e2b3c-4d5f-4a6b-8c9d-0e1f2a3b4c5d",
        "status": "final",
        "code": "79560-9",
        "valueQuantity": { "value": 350, "unit": "mL" },
        "effectiveDateTime": "2026-09-07T14:00:00.000Z",
        "method": null,
        "enteredMeasurementSystem": "metric"
      }
    },
    {
      "entityType": "Observation",
      "entityId": "8b2f3c4d-5e6f-4a7b-8c9d-1e2f3a4b5c6d",
      "serverSequence": "48214",
      "deleted": true,
      "clientUpdatedAt": "2026-09-07T22:09:03.001Z"
    }
  ],
  "cursor": "48214",
  "hasMore": false
}
```

Changes are ordered by `serverSequence` ascending. The client pulls in a loop until `hasMore` is `false`, persisting `cursor` after each page.

`hasMore` means **there exist further changes at or below what the server is currently willing to serve that this page did not include** — it is about the page, not about the server's high-water mark. It MUST be `false` whenever `changes` is empty. Defining it as `max(serverSequence) > cursor` is the natural mistake and produces `changes: []` with `hasMore: true` under §5.3's own recommended mechanism, which withholds not-yet-committed rows; the client then spins in a tight loop against the API.

**A tombstone carries no `payload`.** The receiving device needs the entity id to remove its local row and nothing else; sending the clinical values of a deleted entry would transmit PHI that serves no purpose, and the minimum-necessary rule applies to a protocol as much as to a screen.

**Both variants carry `clientUpdatedAt`**, and a tombstone's is the client timestamp of the operation that deleted the row — not a server receipt time. It is there because a device holding an unpushed local edit to an entity it has just been told is deleted has to resolve that itself, by the same last-write-wins rule §4 applies server-side, and it cannot do that against a timestamp whose clock it does not share. The server's own `deletedAt` is bookkeeping and does not cross the wire, for the same reason `createdAt` and `updatedAt` do not (§7.2).

`cursor` is the highest sequence the server is willing to let the client advance to (§5.3) — not necessarily the highest in `changes`, and never derived by the client from the rows it received.

### 5.3 The cursor guarantee, and the hazard it hides

> **Normative invariant.** If a client's cursor is `C`, the client has been shown **every** change for that patient with server sequence ≤ `C`. No row is ever skipped.

This is the entire reason ADR-0001 chose a monotonic sequence over an `updated_at` timestamp, and it does not hold for free.

PostgreSQL sequences are non-transactional: `nextval` is consumed before commit, and transactions commit in an order that need not match the values they took. A reader can therefore see sequence 48214 committed while 48213 is still in flight. A client handed `cursor: "48214"` will never ask for 48213 again — and that row is **silently, permanently invisible** to that device. There is no error, no retry, and no way for either side to detect it after the fact.

For v1 the exposure is narrow: `apps/mobile` is the only writer, one patient's writes come from one device, and concurrent in-flight writes for the same patient are rare. It is not zero — the same patient on a second device, a `packages/seed` bulk load, and any future server-side write all produce it — and it is invisible when it happens, which is what makes it worth closing rather than watching.

**P2.S1b must implement a mechanism that makes the invariant true, and prove it with a test that interleaves two concurrent writes and commits them out of order.** The contract fixes the guarantee, not the mechanism. Three candidates, in the order they should be considered:

1. **Withhold the in-flight window.** Compute the cursor from `pg_snapshot_xmin(pg_current_snapshot())` and return no row whose assigning transaction is not yet known-committed. No schema change; the cost is that a just-written row may need one more poll to appear.
2. **Per-patient counter row, taken with `SELECT … FOR UPDATE`.** Makes assignment order equal commit order by construction, because one patient's writes serialize. Costs a schema change and a per-patient write lock, and gives up the global sequence's cross-patient ordering — which nothing reads. It also closes a minor disclosure as a side effect: a global sequence means the gaps between a patient's own consecutive values tell them how many writes every other patient made in between. That is aggregate activity volume rather than a health fact about an identified person, so it is a tiebreaker and not a reason on its own.
3. **Bounded lag.** Return no row whose sequence is within a small window of the maximum. Cheapest and wrong: it narrows the race rather than closing it, and it fails exactly under the load that makes the race likely.

Option 3 is listed to be ruled out explicitly, since it is the one that looks sufficient under a test that does not interleave.

### 5.4 A stale cursor must be refused, because the purge policy will eventually make it lie

The tombstone is the **only** signal that tells a second device to delete its local row. Once tombstones are purged at some horizon — §10, still blocked on the retention period — a device whose cursor predates that horizon will never be shown them, will never delete those rows, and §5.3's invariant quietly becomes false. That is the same silent-invisibility failure the cursor design exists to prevent, arriving through the retention door instead of the concurrency one.

A device left in a drawer for eight months comes back online, pulls from its stale cursor, and keeps clinical entries the patient deleted and the server no longer holds — indefinitely, and invisibly to any later "your data has been deleted" response.

**So: a `since` older than the purge horizon is refused with `CURSOR_TOO_OLD`, and the client responds by wiping local entity state and re-syncing from `since=0`.** The horizon's *value* waits on counsel and is deliberately not named here. The protocol affordance cannot wait, because adding a new protocol error after clients ship is precisely the versioned, coordinated-release change §8 describes — which is to say, it is free today and expensive for the rest of v1.

---

## 6. Error taxonomy

The governing distinction:

- A **protocol error** is a client bug. It fails the whole request with a `4xx`, and there is nothing a patient could correct.
- A **data error** is a problem with one operation's content. It fails that operation only, with a `rejected` result inside a `200`, and it is surfaced to the patient for correction.

Conflating them is how "a batch never fails as a unit" turns into "a malformed batch silently half-applies", and how a client bug reaches a patient as a confusing correction prompt.

### 6.1 Protocol errors — whole request fails

| Condition | `code` | Status |
| --- | --- | --- |
| Malformed JSON; a missing required field at the request or operation level; an **unrecognized key** at the request or operation level (§2); an unknown `entityType` or `operationType`; a missing or non-numeric `since`; two operations sharing an `operationId` | `MALFORMED_REQUEST` | `400` |
| `clientTimestamp` array not non-descending | `BATCH_OUT_OF_ORDER` | `400` |
| `payload` present on a delete, or absent on a create/update | `PAYLOAD_PRESENCE_INVALID` | `400` |
| `payload.id` does not equal the operation's `entityId` (§7.2) | `ENTITY_ID_MISMATCH` | `400` |
| Missing, expired, or invalid token | `UNAUTHENTICATED` | `401` |
| More than `SYNC_PUSH_MAX_OPERATIONS` operations | `BATCH_TOO_LARGE` | `413` |
| `since` older than the tombstone purge horizon (§5.4) | `CURSOR_TOO_OLD` | `409` |

Note what is deliberately **not** here: anything about the *content* of a payload field. A recognized field carrying an out-of-domain value is a data error (§6.2) and fails one operation. Escalating it to a `400` is how "a batch never fails as a unit" turns back into the all-or-nothing batching ADR-0001 rejected — one bad row from an old app version blocking every entry a patient made while offline. A whole-body DTO validator applied to the operations array does exactly that, so per-operation payload validation MUST run per operation.

The body is minimal and fixed:

```json
{ "error": { "code": "BATCH_OUT_OF_ORDER" } }
```

**No prose, no field path, no echoed request content, and no index into the offending operation.** The same §6.3 rule applies here and applies harder: a protocol error is exactly where an implementation reaches for "helpful" diagnostics, and the request it would quote is a batch of clinical values. What a client needs is a stable code it can log and report; what it must not be handed is anything derived from what it sent. The code exists so that two independent client implementations log the same thing for the same server condition — without it, P2.S1b and P2.S2b each invent a shape and neither can read the other's diagnostics.

A protocol error applies **no** operations. The client retains the whole batch and must not retry it unchanged; retrying a `400` unchanged is an infinite loop against a bug the server has already diagnosed.

**This shape is not what a framework produces by default, and that is the harder half of the requirement.** A NestJS `ValidationPipe` emits `{"statusCode":400,"message":[...],"error":"Bad Request"}`, and with the `forbidNonWhitelisted` §2 requires, those messages read `property patientId should not exist` — echoing a client-supplied key straight back, which §6.2 forbids. Express's body-size limit produces its own `PayloadTooLargeError` body. And the patient guard already shipped in P1.S1 throws `{"code":"AUTH_MISSING_TOKEN"}` — a different envelope *and* a different vocabulary from `UNAUTHENTICATED`. None of these pass through the type that makes this shape safe.

**P2.S1b therefore owes a sync-scoped exception filter** that maps every `4xx` leaving `/api/v1/sync/**` into this body and discards any framework-supplied `message`, plus a test asserting each of the seven conditions returns a body whose only keys are `error` → `code`. It also owes a decision, in that sprint, on whether `UNAUTHENTICATED` subsumes the guard's `AUTH_*` codes or the guard's codes are what this surface returns — today the two artifacts disagree and `UNAUTHENTICATED` is a code nothing emits.

### 6.2 Data errors — one operation rejected

`reasonCode` is machine-readable and stable. `field` names **one operation-level or payload-level field**, spelled exactly as §3.1 and §7 spell it, with payload paths unprefixed (`valueQuantity.value`, not `payload.valueQuantity.value`). Not every rejection is about the payload: `CLIENT_TIMESTAMP_OUT_OF_RANGE` names `clientTimestamp` and `ENTITY_NOT_FOUND` names `entityId`, neither of which is a payload path at all.

The set of legal `field` values is closed and enumerated in `packages/core/src/sync`. This is a §6.3 control, not a tidiness preference — a free-string `field` is a field a clinical value fits in, and `` field: `valueQuantity.value (${value})` `` typechecks perfectly.

| `reasonCode` | Raised when |
| --- | --- |
| Any `TIER1_RULE_CODE` value — `VALUE_NOT_NUMERIC`, `VALUE_NOT_POSITIVE`, `VALUE_EXCEEDS_MAX_MAGNITUDE`, `VALUE_EXCEEDS_MAX_PRECISION`, `METHOD_REQUIRED`, `EFFECTIVE_DATE_TIME_IN_FUTURE`, `EFFECTIVE_DATE_TIME_BEFORE_SURGERY` | Server-side re-enforcement of `packages/core`'s Tier 1 rules (AC 13.1 AC3). Returned verbatim, not remapped. `VALUE_EXCEEDS_MAX_MAGNITUDE` and `VALUE_EXCEEDS_MAX_PRECISION` (P2.S1a) are the canonical column's representability bounds — a value at or beyond `10^8`, or carrying more than 4 decimal places. Both were previously an HTTP `500`, which §9 tells a client to re-push indefinitely; as Tier 1 rejections they are correctable instead. Neither is clinical: implausible-but-real magnitudes stay Tier 2 and are never rejected. |
| `CLIENT_TIMESTAMP_OUT_OF_RANGE` | §3.8. |
| `ENTITY_NOT_FOUND` | An update or delete naming an entity id that has no row of this patient's — tombstoned or otherwise (§4), **and whether the id exists for another patient or for nobody at all** (§2). Not the tombstoned case: a tombstoned row of this patient's still exists for update, delete and conflict resolution. |
| `ENTITY_ID_CONFLICT` | **Never emitted by this surface** (corrected at P2.S1b — see §4). A cross-patient entity id is `ENTITY_NOT_FOUND`, because a distinct code would be the very disclosure §2 forbids; a same-patient create collision is an ordinary last-write-wins comparison (§4), not a rejection. The code remains in `packages/core/src/sync` because the **direct** endpoint (`POST /api/v1/observations`) uses it for its own duplicate-id refusal — that surface is create-only and has no last-write-wins semantics to fall back on. Listed here so a client author who encounters it elsewhere in the codebase is not left wondering why it is absent. |
| `UNSUPPORTED_CODE` | An observation `code` outside the set the current release accepts. |
| `UNSUPPORTED_STATUS` | An observation `status` outside the set the current release accepts (§7.2). |
| `PAYLOAD_FIELD_INVALID` | A **recognized** field carrying a value outside its domain: an `enteredMeasurementSystem` that is neither `metric` nor `imperial`, a `resourceType` other than `"Observation"`, a `valueQuantity.unit` that is not `mL`/`kg` or disagrees with `code`, an `id` that is not a UUID, a `method` the server cannot recognize, or a timestamp not in §7.3's form. Names the field; never the value. This is the code that stops per-field validation from escalating into a request-level `400` (§6.1). |
| `PAYLOAD_FIELD_UNRECOGNIZED` | A field not in §7. Rejected rather than ignored: silently dropping a field a newer client thought it was sending is a data-loss path with no signal on either side. **Reports `field: "payload"` and never the unrecognized key** — the key is client-supplied content, and echoing client-supplied content into a response the client persists and logs is the shape §6.3 forbids. A client that sent the field already knows which one it sent. |

**Tier 2 warnings never appear here.** A soft warning is not a rejection and never becomes one (SRS §3.8). An operation that trips the >2,000 mL threshold is `accepted`; the warning was the client's job to show at entry time, and a real 2,500 mL day is the data point the care team most needs. There is no wire representation of a Tier 2 outcome in a push response, deliberately — a field for it is a field someone will eventually branch on.

### 6.3 Rejections never carry clinical values

A rejection result carries a `reasonCode` and a `field` path. **It never carries the offending value**, in any field, in any encoding. Rejection responses are persisted by the client in its correction queue and appear in client-side diagnostics; a value echoed here is PHI in a log (ADR-0001, `docs/security-hipaa.md`).

`packages/core`'s `ValidationError` type already makes this structurally true for Tier 1 — it has no field a value could occupy — and the sync result type must hold the same shape for the same reason.

**The server MUST build a result by naming its fields, never by spreading a validation result or a database row into it.** TypeScript's excess-property check does not apply to spread properties, so `{ ...validationResult, status: 'rejected', … }` typechecks cleanly and serializes whatever the source object carried. The same applies to §5.2's tombstone: `{ ...row, deleted: true }` compiles and ships the clinical values of a deleted entry. `packages/core/src/sync` exports constructor functions for exactly this reason — they project a fixed field set and cannot be widened from the call site. Where multiple rules fail at once, report the first in the order §6.2 lists, so two servers do not walk one patient through different correction sequences for the same payload.

**A value-free rejection is not thereby safe to send anywhere.** The retained record is `(operationId, entityId, reasonCode, field)`, and the codes are clinically expressive on their own: `EFFECTIVE_DATE_TIME_BEFORE_SURGERY` discloses that the subject has a surgery date, and `field: "valueQuantity.value"` on an observation discloses that they log stoma output. Correlated with a user or device id in a third-party error tracker, that is a health fact about an identified individual sitting in a system with no BAA. A rejection may be stored locally and shown to the patient. It **MUST NOT** be forwarded to third-party error tracking, attached to a crash report, or included in any diagnostic bundle that leaves the device. Removing the value narrows the exposure; it does not make the record non-PHI.

### 6.4 Rendering a rejection to the patient

The server sends codes; the client renders copy. No prose ever crosses this wire (ADR-0006, and the no-hardcoded-strings rule).

Tier 1 reason codes are already keys in `packages/core`'s `validationErrors` catalog, so they resolve with no new strings. The non-validation codes in §6.2 indicate a client or version problem rather than something the patient entered wrongly, and are **not** rendered verbatim to a patient: the client shows one generic "this entry could not be saved — please check it" message and keeps the code for diagnostics.

A client MUST treat an **unrecognized** `reasonCode` the same way. New codes are additive (§8), and an old app must degrade to the generic message rather than crash or render a raw identifier at someone.

---

## 7. Entity payloads

### 7.1 The FHIR rule, and its boundary

Payloads use **FHIR R4 field names and shapes** for everything FHIR defines (AC 2.5 AC1): `resourceType`, `status`, `code`, `valueQuantity.value`, `valueQuantity.unit`, `effectiveDateTime`, `method`. These are not a custom schema mapped to FHIR later; they are the names, on the wire, at rest, and in the database column mapping.

The payload is FHIR-**shaped**, not FHIR-valid. Consistent with the Postgres-over-FHIR-native decision, this repo does not exchange FHIR resources: `code` is a bare LOINC code string rather than a `CodeableConcept`, and there is no `subject` reference because §2 forbids one. Assembling a conformant `Bundle` is the export module's job (P5), from the database, not from this wire format.

App-native fields that FHIR has no element for travel as **plain siblings**, spelled out exhaustively in §7.2. They are not wrapped in a namespace object and not encoded as FHIR `extension` entries — an `extension` array would assert a FHIR-nativity this system deliberately does not have, and a namespace wrapper buys separation the type system already provides. In `packages/core/src/sync` the two groups are separate types intersected into the payload type, so the distinction is visible where it matters and flat where it is transmitted.

**The export module MUST NOT copy an app-native sibling into a FHIR `Bundle`.** That is where the shortcut taken here would become a conformance defect, and it is P5's obligation to respect it.

### 7.2 `Observation`

The only entity type P2 exchanges. `Profile` and `EffectiveRange` are synced entities in the schema but have no wire payload until P4; adding them is additive (§8).

| Wire field | Source | Required | Notes |
| --- | --- | --- | --- |
| `resourceType` | FHIR | yes | Always the literal `"Observation"`. |
| `id` | FHIR | yes | Equals the operation's `entityId`. Present in the payload because FHIR puts it there; a mismatch between the two is a protocol error. |
| `status` | FHIR | yes | FHIR `ObservationStatus`, lowercase on the wire. The wire type is the full eight-member FHIR value set, mirroring storage; **P2 accepts `"final"` only**, and anything else is rejected with `UNSUPPORTED_STATUS`. The type is wider than the accepted set on purpose — widening what a release accepts is additive under §8, whereas widening the type later is not. |
| `code` | FHIR | yes | Bare LOINC code. P2 accepts `79560-9` (stoma output) only; other codes are `UNSUPPORTED_CODE` until their sprint lands. |
| `valueQuantity.value` | FHIR | yes | **Canonical units always** — mL for volume, kg for weight (ADR-0004). The client converts before sending; the server never receives ounces. A decimal, not an integer (ADR-0005). |
| `valueQuantity.unit` | FHIR | yes | `"mL"` or `"kg"`. Determined by `code`, transmitted anyway because FHIR requires it and a stored unit makes a future misreading recoverable rather than guessed at. |
| `effectiveDateTime` | FHIR | yes | RFC 3339, UTC, millisecond precision. The clinical moment — see §1. |
| `method` | FHIR | yes, nullable | The SNOMED CT "Estimation technique" code when estimated; `null` when measured. Explicitly `null`, never omitted: the mandatory Measured/Estimated selection is Tier 1, and an absent key cannot be told apart from a client that does not implement the toggle. **The code itself is still unresolved (D4)** — `packages/core` models it as `{ resolved: false }`, and until it resolves the server accepts `null` and rejects any non-null value with `PAYLOAD_FIELD_INVALID`. |
| `enteredMeasurementSystem` | app-native | yes | `"metric"` or `"imperial"`. Which system the patient **entered** in, resolved from their profile at entry time on the device, never re-derived server-side from the current profile — the profile is mutable and deriving it later is wrong precisely for the patients who switched (ADR-0012). Permanent and unrecoverable per row if stored wrongly. |

Everything a client would want and will not find here is deliberate. There is no `patientId` (§2), no `serverSequence` (server-assigned; a client-supplied one is `PAYLOAD_FIELD_UNRECOGNIZED`), no `deletedAt` (deletes are an `operationType`, not a payload field), and no `createdAt`/`updatedAt` (server bookkeeping).

### 7.3 Numbers on the wire

**`serverSequence` and `appliedServerSequence` are JSON strings, not numbers.** They are 64-bit database values and JSON numbers are IEEE-754 doubles: `JSON.parse` silently loses precision above 2^53. The loss would appear as a cursor that stops advancing, years from now, with no error — the class of bug that costs a week and a data-integrity incident to find. They are strings everywhere, including in `packages/core`'s types.

`valueQuantity.value` stays a JSON number. Its `DECIMAL(12,4)` range is nowhere near the double's exact-integer limit, and making a clinical value a string would push parsing responsibility onto every consumer for no benefit.

All timestamps are RFC 3339 with a `Z` offset and **exactly three** fractional digits, matching the schema's `Timestamptz(3)` — `2026-09-07T14:00:00.000Z`. Not a numeric offset, not a bare second, not six digits. Anything else is `PAYLOAD_FIELD_INVALID`; the lexical form is pinned rather than parsed leniently because "accept it and truncate" turns a client bug into silent precision loss inside the values conflict resolution compares.

---

## 8. Versioning and compatibility

The contract is versioned with the API surface it lives on: `/api/v1/sync/...`. A change that an old client cannot survive requires `/api/v2`, run alongside `v1` until fielded clients have moved.

**Additive without a version bump:** a new `entityType`; a new optional payload field on an existing entity; a new `reasonCode`; a new result field a client can ignore. Clients MUST tolerate all four — specifically, an unknown `reasonCode` degrades to the generic message (§6.4), and an unknown field in a *response* is ignored rather than treated as an error.

**Requires a version bump:** removing or renaming a field; changing a field's type or units; changing the meaning of a status; making an optional field required; tightening validation such that a payload an old client can construct is now rejected.

Note the asymmetry: unknown fields in a **response** are ignored, while unknown fields in a **request payload** are rejected (`PAYLOAD_FIELD_UNRECOGNIZED`). A server ignoring a field a client meant to send loses patient data with no signal; a client ignoring a field a server added loses nothing.

**Open, and deliberately not solved here:** nothing on this wire tells the server which client version sent a request, so nothing tells you when `v1` has no fielded clients left and can be retired. A `User-Agent` convention or an explicit header would answer it. It is left open rather than guessed at because the answer belongs with whoever owns release and app-store cadence, and it is recorded because the question first becomes urgent at the moment it is most expensive — the first breaking change.

---

## 9. What a client must never do

Collected here because each is a real failure mode with a silent consequence, and because this list is the one a reviewer can check a client implementation against directly.

1. **Drop a rejected operation.** It is retained locally and surfaced for correction (AC 13.1 AC4). Data loss here is invisible to everyone including the patient.
2. **Retry a rejected operation unchanged.** Same input, same rejection, forever.
3. **Treat a `5xx` or a network failure as a rejection.** The operation's fate is unknown; re-push it and let idempotency (§3.7) settle it.
4. **Advance the delta cursor from anything but a delta response** (§3.6).
5. **Confirm a save from a network response.** The local write is the confirmation (SRS §4.5). Sync is invisible to the patient except when it produces something to correct.
6. **Reorder or coalesce queued operations before pushing.** Two edits to one entity are two operations; merging them destroys the intermediate version the audit log is entitled to.
7. **Reuse an operation id.** It is minted at enqueue, once, and it is the only thing standing between a retry and a duplicate row.
8. **Forward a rejection off the device** — to third-party error tracking, a crash report, or any diagnostic bundle (§6.3). The reason codes are health facts even with no value attached.

---

## 10. Open

**Tombstone purge policy — RESOLVED, not yet built.** ADR-0017 sets retention at the account's lifetime, with a deletion request revoking access at once and hard-purging within 30 days. Tombstone purge runs on that trigger, server-side and on-device, and no longer waits on an open question. §5.4 records what the protocol must provide regardless, and §4.1 records why the audit event for a delete has to carry the full pre-deletion state: after a purge it is the only surviving copy — and note that ADR-0017 now purges those audit rows too, so for a deleted account there is eventually no surviving copy at all, which is the intended outcome.

**A third-party-vendor question this contract creates.** §6.3 forbids forwarding a rejection off the device. If `apps/mobile` adopts third-party error tracking at P2.S2b, that vendor enters the PHI path and joins the service list in `docs/security-hipaa.md`. Under the FTC rule (`docs/compliance/breach-notification.md`) no BAA is required, but the vendor's own breach of our data is still our notification event — raise it before that sprint, not after.

**The SNOMED CT estimation-technique code (D4).** Until it resolves, `method` accepts only `null`. `packages/core`'s `ESTIMATION_METHOD_CODE` is a discriminated union in the `{ resolved: false }` state, so a write path cannot typecheck against an unresolved code by accident.

**Re-check at Gate C**, when two-device sync and preference propagation first exercise this contract under real conditions — the same trigger ADR-0001 names.
