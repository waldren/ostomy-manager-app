# Performance baseline (P4.S5)

Issue #158. SRS §5.1 is directional ("must feel instantaneous", "without noticeable delay") and asks for numeric targets once a spike has measured the real stack. This document is that spike's record: what was measured, how, on what, and what the numbers cannot speak for. **P9.S4 sets the targets.** Every target proposed here is an implementer's proposal, with the same standing as the unratified clinical defaults.

Built up slice by slice; a section not yet measured says so.

## 1. API (slice 1)

### How

`scripts/perf/api-baseline.mjs`, run 2026-10-24 against the local Compose stack at `70d4b81`. Raw output: [`runs/2026-10-24-api-baseline.json`](runs/2026-10-24-api-baseline.json).

- **Data.** Two synthetic patients provisioned by the script, each with 90 days of history written through `POST /sync/push` exactly as the phone sends it: **typical**, 15 entries a day (1,350, `colostomy-baseline`'s density), and **heavy**, 30 a day (2,700). Six stoma outputs, seven drinks and two urine entries in every fifteen.
- **Method.** Sequential requests, one at a time, after 20 untimed warm-ups; 200 samples per operation (20 for the full pull, which is many requests each). Each sample includes reading the whole response. The sync rate limiter (60 requests a minute per patient) was **waited out and not timed**: 10 waits this run.
- **Host.** Intel Core i9-14900HX (24 cores), 32 GB RAM, Windows 11 Pro, Docker 29.5.2 with 32 CPUs and 15.4 GB available to it. API, PostgreSQL and the client on one machine, so there is no network latency in any number.

### Results (milliseconds)

| Operation | n | p50 | p95 | p99 | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `POST /sync/push`, 1 operation | 200 | 9.2 | 12.9 | 24.0 | what one saved entry costs the server, later |
| `POST /observations` | 200 | 7.6 | 11.0 | 12.8 | the direct write path |
| `POST /sync/push`, 50 operations (typical) | 27 | 597 | 781 | 802 | about 12 ms an operation |
| `POST /sync/push`, 50 operations (heavy) | 54 | 653 | 731 | 783 | |
| `GET /sync/delta`, full first pull (typical) | 20 | 70 | 92 | 113 | 7 pages, 1,351 changes, 656 KB |
| `GET /sync/delta`, full first pull (heavy) | 20 | 129 | 163 | 175 | 14 pages, 2,701 changes, 1.3 MB |
| `GET /observations`, 30 days (typical) | 200 | 9.1 | 11.7 | 352 | 450 entries; one cold outlier set p99 |
| `GET /observations`, 90 days (typical) | 200 | 9.5 | 11.7 | 13.4 | **truncated at 500** of about 1,350 |
| `GET /observations`, 30 days (heavy) | 200 | 9.3 | 12.0 | 13.3 | **truncated at 500** of about 900 |
| `GET /observations`, 90 days (heavy) | 200 | 9.8 | 12.9 | 14.0 | **truncated at 500** of 2,700 |

### What they show

- **Nothing here is near a patient-visible problem.** A save never waits on the server (the phone writes locally and pushes later), and the server's own cost is about 10 ms an entry.
- **A batch costs about 12 ms per operation**, because each operation is validated, written and audited in turn (per-operation results, `docs/sync-contract.md` §3.4). A phone returning from a long time offline with 500 queued entries would spend about 6 seconds pushing them, in the background.
- **A new or reinstalled phone's first sync of 90 days is well under a second** of server time even for the heavy patient. A year of heavy history is about 55 pages, which approaches the sync rate limit by itself; see #159 for what the phone currently does when it hits it.
- **`GET /observations` cannot serve a 90-day history.** It caps a page at 500 rows and has no cursor, so 90 days of a typical patient, and even 30 days of a heavy one, come back silently truncated (the response does say so: the page is full). That is a design input for P5.S1's history view, not a latency problem.

### What they cannot speak for

- **Production.** Fargate, RDS across a network, TLS and real Cognito are P4.S6's staging spike. These numbers are for comparing operations with each other and catching an order-of-magnitude problem, not for setting a server SLO.
- **Concurrency.** One patient, one request at a time, which is what §5.1 is about. Load under many patients is not measured.

### Proposed targets for P9.S4

None for the API itself. §5.1 is about what the patient perceives, and no API call is on the path of a save. The numbers above become the regression baseline for P9.S4's own run against staging.

## 2. Phone (slices 2 and 3)

Not yet measured.

## 3. Web (slice 4)

Not yet measured.

## 4. Proposed targets (slice 5)

Not yet written.
