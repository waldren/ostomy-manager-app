# Performance baseline (P4.S5)

Issue #158. SRS §5.1 is directional ("must feel instantaneous", "without noticeable delay") and asks for numeric targets once a spike has measured the real stack. This document is that spike's record: what was measured, how, on what, and what the numbers cannot speak for. **P9.S4 sets the targets.** Every target proposed here is an implementer's proposal, with the same standing as the unratified clinical defaults.

Built up slice by slice; a section not yet measured says so.

## 1. API (slice 1)

### How

`scripts/perf/api-baseline.mjs`, run twice on 2026-10-24 against the local Compose stack at `70d4b81`. The tables are **run 2**, the version of the script after code review, which keeps every raw sample: [`runs/2026-10-24-api-baseline-run2.json`](runs/2026-10-24-api-baseline-run2.json). Run 1, from the first version, is kept beside it ([`run1`](runs/2026-10-24-api-baseline-run1.json)) because of what it shows about variance (below).

- **Data.** Two synthetic colostomy patients provisioned by the script, each with 90 days of history written through `POST /sync/push` as the phone sends it: **typical**, 15 entries a day (1,350, `colostomy-baseline`'s density), and **heavy**, 30 a day (2,700). Six stoma outputs, seven drinks and two urine entries in every fifteen.
- **Method.** One request at a time. Each sample includes reading the whole response. Warm-up and sample count differ by operation and are in each row: 20 warm-ups and 200 samples for the single requests; 2 warm-ups and 20 samples for the full pull, which is 7 to 14 requests per sample; 2 and 30 for the steady-state 50-operation push; 1 and 10 for the 500-operation push. The **seeding** rows are different in kind: the pushes that built each history, timed in order with **no** warm-up, while the history grew from empty to full.
- **Percentiles** are nearest-rank. p99 is shown only from 100 samples up, because below that it is simply the maximum.
- **The sync rate limiter** (60 requests a minute per patient) was **waited out and not timed**: 11 waits in run 2.
- **Host.** Intel Core i9-14900HX (24 cores), 32 GB RAM, Windows 11 Pro, Docker 29.5.2 with 32 CPUs and 15.4 GB available to it. API, PostgreSQL and the client on one machine, so there is no network latency in any number.

### Results, run 2 (milliseconds)

| Operation | n | p50 | p95 | p99 | Notes |
| --- | ---: | ---: | ---: | ---: | --- |
| `POST /sync/push`, 1 operation | 200 | 9.7 | 15.7 | 23.7 | one saved entry, pushed later |
| `POST /observations` | 200 | 7.9 | 11.3 | 17.8 | the direct write path |
| `POST /sync/push`, 50 operations, steady state | 30 | 299 | 385 | – | about 6 ms an operation |
| `POST /sync/push`, **500** operations | 10 | 2,858 | 3,325 | – | the phone's own batch ceiling |
| seeding push, 50 operations (typical) | 27 | 301 | 349 | – | first quarter mean 319, last 302 |
| seeding push, 50 operations (heavy) | 54 | 285 | 398 | – | first quarter mean 296, last 275 |
| `GET /sync/delta`, full first pull (typical) | 20 | 66 | 91 | – | 7 pages, 1,351 changes, 657 KB |
| `GET /sync/delta`, full first pull (heavy) | 20 | 141 | 160 | – | 14 pages, 2,701 changes, 1.3 MB |
| `GET /observations`, 30 days (typical) | 200 | 9.5 | 12.3 | 13.5 | 450 entries |
| `GET /observations`, 90 days (typical) | 200 | 10.2 | 12.6 | 16.3 | **full page: 500** of about 1,350 |
| `GET /observations`, 30 days (heavy) | 200 | 11.1 | 15.3 | 18.8 | **full page: 500** of about 900 |
| `GET /observations`, 90 days (heavy) | 200 | 12.9 | 16.2 | 18.0 | **full page: 500** of 2,700 |

### What they show

- **Nothing here is near a patient-visible problem.** A save never waits on the server: the phone writes locally and pushes later. The server's own cost is about 10 ms an entry.
- **A batch costs about 6 ms per operation in run 2, and does not grow with history.** Each operation is validated, written and audited in turn (per-operation results, `docs/sync-contract.md` §3.4). The seeding batches cost the same at the end of each history as at the start, so the cost per operation does not depend on how many entries the patient already has, at least up to 2,700.
- **The phone's largest request takes about 3 seconds.** A phone back from a long time offline sends up to 500 queued entries in one push (`DEFAULT_MAX_OPERATIONS_PER_BATCH`), and that request took 2.8 to 3.3 s here. It runs in the background. It is the number P4.S6 should re-measure first, because RDS adds a network round trip to every statement in it, and any load-balancer or proxy timeout applies to it whole.
- **Batch costs vary about twofold between runs.** Run 1 measured its seeding batches at a p50 of 597 ms (typical) and 653 ms (heavy), against 301 and 285 in run 2, with the same stack, data shape and host. Run 1 kept no raw samples, so its cause is not known. Single requests agreed between the runs within a millisecond or two. Treat any batch figure here as "a few hundred milliseconds per 50", not as a number to compare against.
- **A new or reinstalled phone's first sync of 90 days is well under a second** of server time, even for the heavy patient. A year of heavy history is about 55 pages, which approaches the sync rate limit by itself; #159 covers what the phone currently does when it hits it.
- **`GET /observations` cannot return a 90-day history in one request.** It caps a page at 500 rows and has no cursor. A full page is the only sign a window held more: the response carries nothing else, so a window of exactly 500 looks the same. 90 days of a typical patient, and even 30 days of a heavy one, come back cut short. A client could page by moving `effectiveDateTimeTo` down (it is inclusive, newest first), though entries sharing a boundary instant would repeat. That is a design input for P5.S1's history view, not a latency problem.

### What they cannot speak for

- **Production.** Fargate, RDS across a network, TLS and real Cognito are P4.S6's staging spike. These numbers are for comparing operations with each other and catching an order-of-magnitude problem, not for setting a server SLO.
- **Concurrency.** One patient, one request at a time, which is what §5.1 is about. Load under many patients is not measured.

### Proposed targets for P9.S4

None for the API itself. §5.1 is about what the patient perceives, and no API call is on the path of a save. The numbers above become the regression baseline for P9.S4's own run against staging, with `--allow-remote`.

## 2. Phone (slices 2 and 3)

Not yet measured.

## 3. Web (slice 4)

Not yet measured.

## 4. Proposed targets (slice 5)

Not yet written.
