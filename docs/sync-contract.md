# Sync wire contract

**Status:** Normative. This document is the authoritative reference for the offline sync wire format. It implements [ADR-0001](../design-specs/decisions/0001-sync-contract-and-conflict-semantics.md) and is bound by SRS_v2 §3.6, §3.8, §4.5, §5.3 and AC 13.1.

**Scope.** The wire format only: request and response shapes, ordering, idempotency, conflict resolution, tombstones, the delta cursor, and the error taxonomy. It does not describe the mobile client's local queue schema (`apps/mobile`, P2.S2) or the server's handler structure (`apps/api`, P2.S1b). It describes what crosses the network between them, which is the part neither side may change unilaterally.

**Who this binds.** `apps/mobile` is the only sync client — `apps/web` is online-only by explicit decision (SRS §4.3) and never speaks this protocol. The types are in `packages/core/src/sync`, owned by `nestjs-api-developer` under [ADR-0007](../design-specs/decisions/0007-packages-core-ownership.md). This document and those types must agree; where they disagree, this document is wrong until it is corrected, because a type can be regenerated and a fielded app cannot.

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

A descending array is a **protocol error** (§6.1), not a per-operation rejection. It means the client's queue processor is broken; there is nothing a patient could correct.

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

### 3.6 `appliedServerSequence` is a receipt, not a cursor

Present on `accepted` and `superseded` results; absent on `rejected`. It names the server sequence of the entity row as it stands after this operation was processed — for `superseded`, that is the winning row's sequence, not this operation's.

**A client MUST NOT use it to advance its delta cursor.** The sequence is assigned globally across patients and rows; a value observed here says nothing about which other rows have become visible. Advancing the cursor from a push receipt would skip every row written between the client's last delta pull and this batch. The delta cursor comes from §5 and from nowhere else.

### 3.7 Idempotency and replay

Idempotency is keyed on **`(patient, operationId)` together**, never on `operationId` alone. The operation id is chosen by an untrusted offline device and is not patient-scoped by construction: a buggy or malicious client could choose one that another patient's device already used, and a global uniqueness check would let patient A's write cause patient B's distinct push to be refused as a replay. The lookup is always by the pair.

A re-pushed operation returns **the result the first attempt produced**, byte-for-byte apart from `replayed: true`, and has no further effect. A replayed rejection is still a rejection; a replayed create makes no second row. This is what makes the "push, lose the connection before reading the response, push again" sequence safe, which is the ordinary case on a phone, not the exotic one.

`replayed` is diagnostic. It is always present. A client MUST NOT branch clinical behaviour on it.

### 3.8 Clock skew on `clientTimestamp`

An operation whose `clientTimestamp` is further in the future than the `sync_clock_skew_allowance_seconds` threshold allows is **rejected** with `CLIENT_TIMESTAMP_OUT_OF_RANGE`.

This is separate from the Tier 1 rule that blocks a future `effectiveDateTime` (`EFFECTIVE_DATE_TIME_IN_FUTURE`), and it exists for a different reason. `effectiveDateTime` in the future is a data-entry mistake. `clientTimestamp` in the future is a **poisoned timestamp**: because conflict resolution is last-write-wins by client timestamp, a device with a clock set to 2031 wins every conflict against every other device, permanently, for every entity it touches. Nothing else in the protocol bounds that.

The allowance is an admin-managed threshold (ADR-0001 point 5), read from `validation_thresholds` under the key `sync_clock_skew_allowance_seconds`, not a constant in code. `packages/core`'s `VolumetricValidationThresholds.maxClockSkewMs` is the same clinical quantity expressed in milliseconds; both derive from the one row.

There is no symmetric past bound. A device offline for three weeks legitimately pushes three-week-old timestamps, and that queue is exactly what must not be discarded.

---

## 4. Conflict resolution

Last-write-wins by client timestamp, applied server-side (SRS §4.5). The comparison is between the incoming operation's `clientTimestamp` and the stored row's `clientUpdatedAt`.

| Case | Outcome | The losing version |
| --- | --- | --- |
| Incoming is **newer** | Applied. Result `accepted`. | The **stored** version, as it was before the write, goes to the audit log. |
| Incoming is **older** | Not applied. Result `superseded`. | The **incoming** version goes to the audit log. |
| **Equal** | Applied. Result `accepted`. | The stored version goes to the audit log. |

Equal timestamps resolve in favour of the incoming operation deliberately. The alternative — refusing to apply — makes a legitimate correction made inside the same millisecond disappear with no signal, and ties are a millisecond-resolution artifact rather than a real simultaneity.

**The losing version is written to the audit log rather than discarded** (SRS §4.5, CLAUDE.md). This is not optional and not best-effort. It is the only reason last-write-wins is acceptable for clinical data at all: nothing a patient recorded is destroyed, it is moved somewhere append-only.

The audit event for a conflict loser carries `reasonCode: "sync_conflict_loser"` and the same actor, correlation id, and before/after shape as any other audited write. It routes through the same `AuditService` as a direct write — not a parallel path (ADR-0001, "Compliance and safety review"). The two paths that get missed when audit logging is added per-handler are the sync-applied write and the conflict loser, and the P1.S5 interceptor covers routes rather than individual writes, so **P2.S1b owes a test asserting that the count of `sync_conflict_loser` audit rows equals the number of conflicts resolved.**

Deletes participate in last-write-wins like any other operation: a delete at T2 beats an update at T1, and an update at T2 beats a delete at T1, resurrecting the row by clearing `deletedAt`.

---

## 5. `GET /api/v1/sync/delta`

### 5.1 Request

```
GET /api/v1/sync/delta?since=48198&limit=200
```

| Parameter | | |
| --- | --- | --- |
| `since` | required | Server sequence, **exclusive**. `0` requests everything — the initial sync of a newly installed or reinstalled app. |
| `limit` | optional | Page size, default 200, maximum 1000. |

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
      "deletedAt": "2026-09-07T22:09:03.001Z"
    }
  ],
  "cursor": "48214",
  "hasMore": false
}
```

Changes are ordered by `serverSequence` ascending. The client pulls in a loop until `hasMore` is `false`, persisting `cursor` after each page.

**A tombstone carries no `payload`.** The receiving device needs the entity id to remove its local row and nothing else; sending the clinical values of a deleted entry would transmit PHI that serves no purpose, and the minimum-necessary rule applies to a protocol as much as to a screen.

`cursor` is the highest sequence the server is willing to let the client advance to (§5.3) — not necessarily the highest in `changes`, and never derived by the client from the rows it received.

### 5.3 The cursor guarantee, and the hazard it hides

> **Normative invariant.** If a client's cursor is `C`, the client has been shown **every** change for that patient with server sequence ≤ `C`. No row is ever skipped.

This is the entire reason ADR-0001 chose a monotonic sequence over an `updated_at` timestamp, and it does not hold for free.

PostgreSQL sequences are non-transactional: `nextval` is consumed before commit, and transactions commit in an order that need not match the values they took. A reader can therefore see sequence 48214 committed while 48213 is still in flight. A client handed `cursor: "48214"` will never ask for 48213 again — and that row is **silently, permanently invisible** to that device. There is no error, no retry, and no way for either side to detect it after the fact.

For v1 the exposure is narrow: `apps/mobile` is the only writer, one patient's writes come from one device, and concurrent in-flight writes for the same patient are rare. It is not zero — the same patient on a second device, a `packages/seed` bulk load, and any future server-side write all produce it — and it is invisible when it happens, which is what makes it worth closing rather than watching.

**P2.S1b must implement a mechanism that makes the invariant true, and prove it with a test that interleaves two concurrent writes and commits them out of order.** The contract fixes the guarantee, not the mechanism. Three candidates, in the order they should be considered:

1. **Withhold the in-flight window.** Compute the cursor from `pg_snapshot_xmin(pg_current_snapshot())` and return no row whose assigning transaction is not yet known-committed. No schema change; the cost is that a just-written row may need one more poll to appear.
2. **Per-patient counter row, taken with `SELECT … FOR UPDATE`.** Makes assignment order equal commit order by construction, because one patient's writes serialize. Costs a schema change and a per-patient write lock, and gives up the global sequence's cross-patient ordering — which nothing reads.
3. **Bounded lag.** Return no row whose sequence is within a small window of the maximum. Cheapest and wrong: it narrows the race rather than closing it, and it fails exactly under the load that makes the race likely.

Option 3 is listed to be ruled out explicitly, since it is the one that looks sufficient under a test that does not interleave.

---

## 6. Error taxonomy

The governing distinction:

- A **protocol error** is a client bug. It fails the whole request with a `4xx`, and there is nothing a patient could correct.
- A **data error** is a problem with one operation's content. It fails that operation only, with a `rejected` result inside a `200`, and it is surfaced to the patient for correction.

Conflating them is how "a batch never fails as a unit" turns into "a malformed batch silently half-applies", and how a client bug reaches a patient as a confusing correction prompt.

### 6.1 Protocol errors — whole request fails

| Condition | Status |
| --- | --- |
| Malformed JSON, missing required top-level field, unknown `entityType` or `operationType` | `400` |
| `clientTimestamp` array not non-descending | `400` |
| `payload` present on a delete, or absent on a create/update | `400` |
| Missing, expired, or invalid token | `401` |
| More than `SYNC_PUSH_MAX_OPERATIONS` operations | `413` |

A protocol error applies **no** operations. The client retains the whole batch and must not retry it unchanged; retrying a `400` unchanged is an infinite loop against a bug the server has already diagnosed.

### 6.2 Data errors — one operation rejected

`reasonCode` is machine-readable and stable. `field` is a dotted path into `payload`, using the wire field names exactly as §7 spells them.

| `reasonCode` | Raised when |
| --- | --- |
| Any `TIER1_RULE_CODE` value — `VALUE_NOT_NUMERIC`, `VALUE_NOT_POSITIVE`, `METHOD_REQUIRED`, `EFFECTIVE_DATE_TIME_IN_FUTURE`, `EFFECTIVE_DATE_TIME_BEFORE_SURGERY` | Server-side re-enforcement of `packages/core`'s Tier 1 rules (AC 13.1 AC3). Returned verbatim, not remapped. |
| `CLIENT_TIMESTAMP_OUT_OF_RANGE` | §3.8. |
| `ENTITY_NOT_FOUND` | An update or delete naming an entity id that does not exist for this patient. |
| `ENTITY_ID_CONFLICT` | A create naming an entity id that already exists with different content — distinct from a replay, which is matched on operation id and never reaches validation. |
| `UNSUPPORTED_CODE` | An observation `code` outside the set the current release accepts. |
| `PAYLOAD_FIELD_UNRECOGNIZED` | A field not in §7. Rejected rather than ignored: silently dropping a field a newer client thought it was sending is a data-loss path with no signal on either side. |

**Tier 2 warnings never appear here.** A soft warning is not a rejection and never becomes one (SRS §3.8). An operation that trips the >2,000 mL threshold is `accepted`; the warning was the client's job to show at entry time, and a real 2,500 mL day is the data point the care team most needs. There is no wire representation of a Tier 2 outcome in a push response, deliberately — a field for it is a field someone will eventually branch on.

### 6.3 Rejections never carry clinical values

A rejection result carries a `reasonCode` and a `field` path. **It never carries the offending value**, in any field, in any encoding. Rejection responses are persisted by the client in its correction queue and appear in client-side diagnostics; a value echoed here is PHI in a log (ADR-0001, `docs/security-hipaa.md`).

`packages/core`'s `ValidationError` type already makes this structurally true for Tier 1 — it has no field a value could occupy — and the sync result type must hold the same shape for the same reason.

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
| `status` | FHIR | yes | FHIR `ObservationStatus`, lowercase on the wire (`"final"`). |
| `code` | FHIR | yes | Bare LOINC code. P2 accepts `79560-9` (stoma output) only; other codes are `UNSUPPORTED_CODE` until their sprint lands. |
| `valueQuantity.value` | FHIR | yes | **Canonical units always** — mL for volume, kg for weight (ADR-0004). The client converts before sending; the server never receives ounces. A decimal, not an integer (ADR-0005). |
| `valueQuantity.unit` | FHIR | yes | `"mL"` or `"kg"`. Determined by `code`, transmitted anyway because FHIR requires it and a stored unit makes a future misreading recoverable rather than guessed at. |
| `effectiveDateTime` | FHIR | yes | RFC 3339, UTC, millisecond precision. The clinical moment — see §1. |
| `method` | FHIR | yes, nullable | The SNOMED CT "Estimation technique" code when estimated; `null` when measured. Explicitly `null`, never omitted: the mandatory Measured/Estimated selection is Tier 1, and an absent key cannot be told apart from a client that does not implement the toggle. **The code itself is still unresolved (D4)** — `packages/core` models it as `{ resolved: false }`, and until it resolves the server accepts `null` and rejects any non-null value it cannot recognize. |
| `enteredMeasurementSystem` | app-native | yes | `"metric"` or `"imperial"`. Which system the patient **entered** in, resolved from their profile at entry time on the device, never re-derived server-side from the current profile — the profile is mutable and deriving it later is wrong precisely for the patients who switched (ADR-0012). Permanent and unrecoverable per row if stored wrongly. |

Everything a client would want and will not find here is deliberate. There is no `patientId` (§2), no `serverSequence` (server-assigned; a client-supplied one is `PAYLOAD_FIELD_UNRECOGNIZED`), no `deletedAt` (deletes are an `operationType`, not a payload field), and no `createdAt`/`updatedAt` (server bookkeeping).

### 7.3 Numbers on the wire

**`serverSequence` and `appliedServerSequence` are JSON strings, not numbers.** They are 64-bit database values and JSON numbers are IEEE-754 doubles: `JSON.parse` silently loses precision above 2^53. The loss would appear as a cursor that stops advancing, years from now, with no error — the class of bug that costs a week and a data-integrity incident to find. They are strings everywhere, including in `packages/core`'s types.

`valueQuantity.value` stays a JSON number. Its `DECIMAL(12,4)` range is nowhere near the double's exact-integer limit, and making a clinical value a string would push parsing responsibility onto every consumer for no benefit.

All timestamps are RFC 3339 with a `Z` offset and millisecond precision, matching the schema's `Timestamptz(3)`.

---

## 8. Versioning and compatibility

The contract is versioned with the API surface it lives on: `/api/v1/sync/...`. A change that an old client cannot survive requires `/api/v2`, run alongside `v1` until fielded clients have moved.

**Additive without a version bump:** a new `entityType`; a new optional payload field on an existing entity; a new `reasonCode`; a new result field a client can ignore. Clients MUST tolerate all four — specifically, an unknown `reasonCode` degrades to the generic message (§6.4), and an unknown field in a *response* is ignored rather than treated as an error.

**Requires a version bump:** removing or renaming a field; changing a field's type or units; changing the meaning of a status; making an optional field required; tightening validation such that a payload an old client can construct is now rejected.

Note the asymmetry: unknown fields in a **response** are ignored, while unknown fields in a **request payload** are rejected (`PAYLOAD_FIELD_UNRECOGNIZED`). A server ignoring a field a client meant to send loses patient data with no signal; a client ignoring a field a server added loses nothing.

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

---

## 10. Open

**Tombstone purge policy.** Tombstones accumulate and are retained indefinitely. The purge policy is coupled to the PHI retention period, which is still with counsel (ADR-0001, Notes).

**The SNOMED CT estimation-technique code (D4).** Until it resolves, `method` accepts only `null`. `packages/core`'s `ESTIMATION_METHOD_CODE` is a discriminated union in the `{ resolved: false }` state, so a write path cannot typecheck against an unresolved code by accident.

**Re-check at Gate C**, when two-device sync and preference propagation first exercise this contract under real conditions — the same trigger ADR-0001 names.
