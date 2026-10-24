# Performance baseline (P4.S5)

Issue #158. SRS §5.1 is directional ("must feel instantaneous", "without noticeable delay") and asks for numeric targets once a spike has measured the real stack. This document is that spike's record: what was measured, how, on what, and what the numbers cannot speak for. **P9.S4 sets the targets.** Every target proposed here is an implementer's proposal, with the same standing as the unratified clinical defaults.

## Summary

- **Saving is fast, and stays fast offline.** The phone commits an entry in about 25 ms and confirms it in about 80 ms. The server is never on that path.
- **Background sync is the one §5.1 breach found.** With a sync cycle running, the save confirmation took up to 0.7 s (#164).
- **A new phone's first sync of 90 days takes about 12 s.** Nearly all of it is applying rows on the device, not the server.
- **The web view is quick:** about 33 ms to switch days and about 160 ms to paint a busy day.
- **The API is not the bottleneck anywhere.** Its 500-row cap on `GET /observations` is a design input for P5.S1's history view.
- **Defects the spike found:** a rate-limit response can quarantine correct entries (#159); flaky no-PHI test assertions (#161); a release check for perf-flagged builds (#163); and sync delaying the save confirmation (#164).
- **Every phone number comes from an emulator on a fast desktop.** The proposed targets in section 4 are therefore set for a reference budget phone, which P9.S4 has to choose and measure on.

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

### How

`scripts/perf/phone-baseline.sh` drives the app through `adb`; `scripts/perf/summarise-marks.mjs` turns the collected lines into the tables below. Raw lines and summaries: [`runs/2026-10-24-phone/`](runs/2026-10-24-phone/).

- **The build.** A release APK (Hermes, no Metro), x86_64 only, made 2026-10-24 from `main` at `b9777c0` with `EXPO_PUBLIC_PERF_MARKS=1` and `EXPO_PUBLIC_API_URL=http://localhost:3000` (slice 2's marks, `apps/mobile/src/perf/perfMarks.ts`). Two deviations from a real release, both local and uncommitted:
  - `-PreactNativeArchitectures=x86_64`, because the full four-architecture release build fails on Windows at CMake's path-length limit, the trap `.npmrc` records;
  - `android:usesCleartextTraffic="true"` added to the **generated** `android/app/src/main/AndroidManifest.xml` (gitignored build output). A release build blocks plain HTTP, which is right for production (TLS only) and which also meant the first batch could not reach the dev stack at all. That turned out to be useful: it gave a clean "no sync running" baseline.
- **The device.** Android emulator, Pixel 8 AVD, Android 16 (API 36) Google APIs x86_64 image, 4 virtual cores, 4 GB RAM, default text and display size. The host is the one in section 1. **It held synthetic data only**, the dev patient's seeded history, as `docs/security-hipaa.md` requires of any device running a flagged build.
- **What is timed.** Cold start is Android's own `am start -W` `TotalTime`: process start to the first frame of the activity, which is the lock screen. Everything else is the app's own marks (slice 2), each a duration measured in the app, so `adb`'s own latency is not in them.
- **Two batches.** **No sync**: the first install, before cleartext was allowed, so no sync cycle ran (62 entries queued unsent). **With sync**: the cleartext build, where every save starts a sync cycle. 10 cold starts, 30 saves through the Add a stoma entry form and 30 Quick-Add taps each. 5 of the first batch's 30 save marks were lost to logcat's ring buffer before collection; the driver now enlarges it.
- **The history.** About 1,500 observations over 90 days for the dev patient (`colostomy-baseline` plus the entries these runs added).

### Results (milliseconds)

| Mark | No sync: p50 / p95 / max | With sync: p50 / p95 / max | n |
| --- | --- | --- | --- |
| Cold start to the lock screen (`am start -W`) | 774 / 949 / 949 | 759 / 926 / 926 | 10 |
| Unlock accepted to Home ready (`unlock-to-home`) | 70 / 113 / 113 | 112 / 247 / 247 | 10 |
| 90-day local history read (`history-90d-query`) | 88 / 186 / 186 | 146 / 276 / 276 | 10 |
| Save: validated to committed (`save-write`) | 27 / 39 / 40 | 25 / 35 / 53 | 25 / 30 |
| **Save: validated to "Saved" on Home (`save-confirmed`)** | **79 / 108 / 119** | **235 / 545 / 697** | 25 / 30 |
| Quick-Add tap to committed (`quickadd-write`) | 11 / 17 / 17 | 12 / 21 / 26 | 30 |
| One sync cycle after a save (`sync-cycle`) | — | 745 / 1,116 / 1,365 | 70 |
| **First full sync, new install (`sync-cycle`)** | — | **11,824** (11,322 to 12,364) | 3 |

### What they show

- **A save is fast where it matters, and Quick-Add is immediate.** The local write, validation excluded, is about 25 ms, and a Quick-Add write about 12 ms. With nothing else running, a save reaches its "Saved" confirmation in about 80 ms, and a Quick-Add tap has no loading state to wait on (§5.1, both bullets).
- **Background sync visibly delays the confirmation.** With a sync cycle running, the confirmation took 235 ms at p50 and up to 697 ms. The write itself is no slower; Home's render competes with the cycle every save starts just before navigating. §5.1 says sync must never visibly interfere with entry, and 0.5 to 0.7 s on a fast emulator is visible. **#164.**
- **One sync cycle costs about 745 ms on the phone** against about 10 ms of server time for its push (section 1). Most of the cycle is on the device. #164 lists candidates.
- **A new phone's first sync of 90 days takes about 12 seconds**, against about 0.1 s of server time for the same pull. That is roughly 8 ms per row applied on the device. Home is usable meanwhile, because the sync runs in the background, but a year of typical history would take about 45 seconds this way, and a heavy user's longer. Worth P5.S1's attention, since a history screen on a new phone shows nothing until it finishes.
- **Cold start to the lock screen is under a second** (759 to 774 ms p50), and **unlock to a usable Home is 70 to 112 ms** after the patient's fingerprint or PIN. So a returning patient's first sight of their diary is about a second plus however long they take to unlock.
- **The 90-day local read a history screen will make is 88 to 146 ms** at p50 and up to 276 ms, for about 1,500 rows read and decoded in full. Acceptable as a baseline; P5.S1 should page it rather than read it all, since it grows with history.
- **Contention shows everywhere.** Every mark taken while a cycle could be running is slower in the second batch except the database write. The JavaScript thread is the shared resource, which is #164's point.

### What they cannot speak for

- **Real phones.** A desktop-hosted emulator with 4 virtual cores is far faster than the low-end Android phones this population is likely to own. Every number here is a **floor**. How much slower a real budget phone is was not measured, and guessing would be worse than saying so; `docs/gate-b-hardware-verification.md` is where a real-device run belongs.
- **A real network.** The API was on the same machine, through `adb reverse`. Sync cycles on mobile data would be longer, though they run in the background.
- **Production builds exactly.** The perf APK allowed cleartext and was single-architecture, as described above.

## 3. Web (slice 4)

### How

Through gstack's `browse`, a headless Chromium 145 on the host in section 1 (1280×720), signed in to `apps/web` on the local Compose stack (the web container built at `70d4b81`, the same `apps/web` as `main`) as the development patient. Two scripts run in the page and read the browser's own clocks, so the driver's latency is in neither:

- **`scripts/perf/web-day-switch.js`**: 60 presses of "Show the previous day", each timed from the click until the page's status line has said "Loading" and then names the new day as loaded, plus one animation frame for the paint. That is when a reader sees the day they asked for. A `MutationObserver` watches the status line, because a fast day can load inside one frame. Two first attempts ended too early and were discarded. The date changes in the same render as the click, while the previous day's "loaded" state is still on screen, so for a moment the line names the new date before anything has been fetched.
- **`scripts/perf/web-page-load.js`**: 11 reloads of the page on today, which held 122 entries (the phone runs' saves and Quick-Add taps). It reads Navigation Timing, the three reads' Resource Timing, and Largest Contentful Paint. These are reloads with the app's assets cached and the session already established, which is how a reader returning to the page meets it.

Raw samples: [`runs/2026-10-24-web/`](runs/2026-10-24-web/).

### Results (milliseconds)

| | n | p50 | p95 | max |
| --- | ---: | ---: | ---: | ---: |
| Switch to an empty day | 14 | 17 | 56 | 56 |
| Switch to a day with 12 to 19 entries | 46 | 33 | 40 | 317 |
| Load: HTML and script parsed (`domContentLoaded`) | 11 | 10 | 12 | 12 |
| Load: the day's entries arrived | 11 | 37 | 52 | 52 |
| Load: the last of the three reads arrived (profile, entries, ranges) | 11 | 34 to 37 | 61 | 61 |
| **Load: largest paint, the day's chart or table (LCP)** | 11 | **164** | **200** | 200 |

### What they show

- **Switching days is immediate.** About 33 ms for an ordinary day, from the click to the new day painted, of which the API's share is about 10 ms (section 1). That is §5.1's "responsive when switching ... date ranges" with a wide margin. The one 317 ms sample was the first switch onto a day with data, which is when the chart first renders anything, and it did not recur.
- **The page shows a 122-entry day in about 160 ms** from a reload, with its three reads back by about 60 ms. Rendering, mostly the chart and table, is the rest.
- **The page only ever shows one day.** §5.1's "history views over 30 to 90 days" has nothing to measure on the web yet, and section 1's 500-row cap on `GET /observations` is what a multi-day view will meet first.

### What they cannot speak for

- **A first visit.** These are warm reloads with a session in place. A first visit adds the sign-in round trip and an uncached download of the app's assets, both of which depend on the network and on CloudFront (P4.S6).
- **A slower machine or browser.** A desktop with 32 hardware threads; a reader's laptop or an older browser will be slower, and by an amount this run cannot say.
- **The network.** Browser, web server and API were on one machine.

## 4. Proposed targets (slice 5)

### How to read these

§5.1's follow-up asks for "testable numeric targets". These are **proposals for P9.S4 to ratify, change or reject**, not commitments. They carry the same standing as the unratified clinical defaults: an implementer chose them, and the choice is recorded rather than hidden.

Three principles shaped them:

- **A target is set on a reference device, not on this emulator.** The emulator numbers above are floors. P9.S4 has to pick a reference phone at the low end of what this population owns, and a reference laptop and browser for the web view, and measure on them with the same scripts. A target that only holds on a fast desktop protects no patient.
- **A target describes what the patient perceives, at p95.** The p50 is what most people see; the p95 is what a patient meets several times a week. The perceptual thresholds used are the long-standing ones:
  - about **100 ms** for a response to feel instantaneous;
  - about **1 s** for a wait not to interrupt the flow of a task;
  - Android's own guidance that a **cold start of 5 s or more** is excessive;
  - Core Web Vitals' **2.5 s** for a "good" largest paint on a first visit.
- **Each target names its mark and its script**, so it is testable in exactly the sense §5.1 asks for, and repeatable by whoever checks it.

### The targets

| §5.1 statement | Measure | Measured here (p95; for the phone, the worse of the two batches) | **Proposed target (reference device, p95)** |
| --- | --- | --- | --- |
| Saving feels instantaneous, regardless of network | `save-confirmed`, with sync idle | 108 ms | **≤ 150 ms** |
| | `save-confirmed`, **with a sync cycle running** | 545 ms (max 697) | **≤ 150 ms, the same as idle.** Fails today: #164 |
| | `save-write` (the local commit) | 39 ms | **≤ 75 ms** |
| Quick-Add resolves immediately, with no loading state | `quickadd-write` | 21 ms | **≤ 75 ms**, and no loading indicator, which is architectural and already true |
| Dashboard loads without noticeable delay | `unlock-to-home` | 247 ms | **≤ 500 ms** |
| History over 30 to 90 days loads without noticeable delay | `history-90d-query` (stand-in until P5.S1) | 276 ms | **≤ 1 s to the first screen of history.** P5.S1 should page rather than read all 90 days at once |
| Background sync is transparent | the save target above, with sync running | — | as above |
| | first full sync of 90 days, new install (`sync-cycle`) | 12.4 s | **≤ 30 s**, with entry possible throughout, and a visible sign that history is still arriving |
| Physician view responsive when switching dates | `web-day-switch.js` | 40 ms | **≤ 200 ms** |
| (preamble) cold start | `am start -W` to the lock screen | 949 ms | **≤ 2 s** |
| (web) a returning reader's day view | `web-page-load.js`, largest contentful paint, warm | 200 ms | **≤ 1 s** warm; **≤ 2.5 s** on a first visit |

### Why each number is where it is

- **Save, 150 ms.** Under the 100 ms perception threshold on the emulator today, with headroom for a slower phone, and still short of the 1 s at which a wait becomes something to sit through. The **same target with sync running** is the point of §5.1's "never visibly interfere". Proposing a looser number for that case would ratify #164 rather than fix it.
- **Local commit and Quick-Add, 75 ms.** These are a fraction of the save. A regression in either would show up here before it shows in the confirmation.
- **Home after unlock, 500 ms.** It is reached through a deliberate act (a fingerprint or PIN), which already takes the patient a second or more, so the bar is "do not add a noticeable wait to it".
- **History, 1 s to the first screen.** P5.S1 has not been designed, so the target is on what the patient sees first rather than on reading all 90 days. Reading all of it already approaches 300 ms on the emulator and grows with history.
- **First full sync, 30 s.** About twice the emulator figure, a generous allowance for a slower phone that is still short of "the app is broken". Only a new install meets it, and nothing about entering data waits for it. It does not cover a year of history, which at today's cost per row would be about 45 s on the emulator alone. If P9.S4 needs that case, the cost per row is the thing to bring down, not the target to raise.
- **Day switching, 200 ms.** Comfortably above today's 40 ms and below the point where a reader clicking through days would notice.
- **Cold start, 2 s.** Well inside Android's 5 s line for "excessive". It is measured to the lock screen, because that is the first thing a returning patient sees, and they unlock from there.
- **Web, 1 s warm and 2.5 s first visit.** The first-visit figure is Core Web Vitals' "good" line, which P4.S6's staging and CloudFront would be measured against.

### What is deliberately not proposed

- **No API latency target.** No API call is on the path of anything §5.1 describes. The numbers in section 1 are a regression baseline for P9.S4's own run against staging (`api-baseline.mjs --allow-remote`), not a service-level objective.
- **No target set from a desktop alone.** Each phone row above needs its reference-device measurement before it is adopted. If P9.S4 finds a phone that misses one, the finding is the useful output, not a reason to raise the number.

### What happens to §5.1

Nothing yet. SRS §5.1 keeps its directional statements until P9.S4 adopts targets, and the adopting change updates the SRS, this document's status, and CLAUDE.md together.
