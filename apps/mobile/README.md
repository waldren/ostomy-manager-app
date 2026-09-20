# Mobile App

Expo (managed workflow) React Native patient app. The **only offline-capable
client** in this system (SRS_v2 §4.2, §4.5): every data-entry action writes to
local `expo-sqlite` first and appends to a local `sync_queue` row before any
network call is attempted, and a save confirms from that local write, never
from a network response.

**Current state (P2.S2a — this sprint).** The app skeleton: Expo Router
navigation between a login screen and a placeholder home screen, patient OIDC
login against the mock provider with the refresh token in `expo-secure-store`
unlocked by `expo-local-authentication`, and the local `expo-sqlite` schema
(`observations` mirroring the FHIR-shaped server table, plus `sync_queue` and
`sync_cursor`). **Not built here, by design:** the Add Output screen, the
background sync push/pull worker, and the correction inbox — a separate
dispatch (P2.S2b) owns those and builds on the schema and queue shape defined
in `src/db/`.

## Commands

Run from this directory, or via `pnpm --filter @ostomy/mobile <script>` from
the repo root:

```
pnpm install            # from the repo root — installs the whole workspace
pnpm start              # expo start (Metro bundler; press i/a for a simulator)
#
# NOT Expo Go. This app requires SQLCipher (ADR-0014), which Expo Go does not
# bundle — and stock SQLite ignores `PRAGMA key` silently, so running there
# would write the clinical database in PLAINTEXT with nothing failing. The
# executor now probes `PRAGMA cipher_version` and refuses to open rather
# than let that happen. Use a development build.
pnpm android            # expo run:android
#
# There is deliberately no `ios` script. v1 ships Android only (ADR-0020):
# this app has never been built for iOS, so its SQLCipher plugin, keychain
# accessibility class and biometric invalidation have never compiled on that
# platform. The `ios` block in app.json is retained but inert.
pnpm typecheck          # tsc --noEmit
pnpm test               # jest (jest-expo preset — docs/testing.md)
pnpm test:watch
```

`pnpm verify` at the repo root runs this app's `typecheck` and `test` (via
`pnpm -r --if-present run <script>`) alongside every other workspace, plus
lint and format over `apps/mobile/**`.

Copy `.env.example` to `.env` before running `start`/`android` — see
that file for what each variable means and the OIDC audience assumption this
sprint records.

## The local store and the sync worker

- `src/db/schema.ts` is the single source of the local DDL, applied by
  `src/db/migrations.ts`'s `runMigrations()` against a `schema_migrations`
  version table — additive migrations only, following the same discipline
  `apps/api/prisma/migrations` uses server-side.
- `src/db/executor.ts` defines `SqliteExecutor`, the minimal async interface
  every repository depends on. `src/db/expoSqliteExecutor.ts` is the
  production adapter over `expo-sqlite`. Tests use
  `src/test-support/nodeSqliteExecutor.ts`, a second adapter over Node's
  built-in `node:sqlite`, so the *real* DDL and queries run against a *real*
  SQLite engine on disk — including a close/reopen cycle that stands in for
  "survives app restart and OS background termination," which cannot be
  exercised on a physical device or simulator from this environment. See that
  file's own header comment before relying on it as proof of on-device
  behaviour beyond what it actually demonstrates.
- `src/db/offlineWrites.ts`'s `enqueueObservationCreate` /
  `enqueueObservationUpdate` / `enqueueObservationDelete` are the local
  write-then-enqueue transaction an entry screen calls directly rather than
  re-deriving: both inserts commit together via
  `SqliteExecutor.withTransactionAsync`, matching the "local write is the
  save confirmation" rule.
- `src/auth/AuthContext.tsx` exposes `phase: 'checking' | 'signedOut' |
  'locked' | 'authenticated'` and treats a successful biometric unlock as
  sufficient for **local** app access regardless of whether the subsequent
  refresh-token network call succeeds — see that file's header comment. A
  missing or expired access token only ever blocks a sync network call, never
  local entry.

### `src/sync/` (P2.S2b)

Read `docs/sync-contract.md` before changing anything here; it governs, and
these modules cite it by section throughout.

- **`batching.ts`** — pure. Splits the queue into requests that satisfy §3.2
  (non-descending `clientTimestamp`, so a clock correction does not strand the
  backlog behind a `400`) and §3.3 (the size bound). Concatenating its output
  reproduces its input exactly, which is how §9.6's "never reorder, never
  coalesce" is asserted as a property rather than read for.
- **`pushOperations.ts`** — builds the §3.1 request from the *current*
  `observations` row (never a payload frozen at enqueue; see migration 2), and
  owns the single function that decides a queued operation's fate. Results are
  correlated by `operationId`, never by array position.
- **`responseDecoding.ts`** — the decode boundary. OpenAPI cannot express the
  contract's discriminated unions, so the generated client's result type has
  every union member optional; this turns a response into shapes whose fields
  are guaranteed, and degrades rather than throws on anything §8 makes
  additive. An undecodable result settles **nothing** — it is not a rejection.
- **`deltaPull.ts`** — applies a page and advances the cursor *after* it, one
  page at a time. The cursor comes from a delta response and nowhere else
  (§3.6, §9.4).
- **`syncWorker.ts`** — `runSyncCycle`: push, then pull. Every failure path is
  here, shaped around §9.3 (a `5xx` or a network failure is not a rejection)
  and §6.1 (a protocol error applies nothing and must not be retried
  unchanged — so the worker isolates the offending operation rather than
  stalling the queue behind it).
- **`syncScheduler.ts`** — pure. Backoff policy and the gate that stops two
  cycles running concurrently.
- **`SyncProvider.tsx`** — the four triggers that make sync resume with no
  user action: authenticated-and-ready, connectivity restored, app
  foregrounded, and a backoff timer.

**`useSyncStatus()` must never be wired to a save confirmation** (§9.5). The
local write already is the confirmation; sync is invisible to the patient
except when it produces something to correct.

### Screens and entry (P2.S2b)

- **`app/add-output.tsx`** — the Add Output screen. The save confirms from the
  LOCAL write and never waits on a network response (§9.5); it asks the worker
  to run afterwards and does not care whether it succeeds.
- **`src/entry/useStomaOutputEntry.ts`** — the screen's decision logic with no
  React in it. Two rules worth knowing before editing: every Tier 1 error
  carries the SAME `field`, so messages are routed to the right control by
  **rule code**, not by field; and a converted imperial value is rounded to the
  canonical column's scale, without which `ozToMl(80)` = `2365.882365` trips
  the precision rule and blocks every imperial entry.
- **`app/corrections.tsx`** — the correction inbox (AC 13.1 AC4). Correcting an
  entry is a **new operation** with a fresh id and timestamp
  (`reenqueueCorrectedObservation`), never a retry (§9.2, §9.7), and the
  operation *type* is preserved so a rejected create does not go back as an
  update the server would answer `ENTITY_NOT_FOUND`.
- **`src/entry/rejectionCopy.ts`** — §6.4's rendering rule. Tier 1 codes
  resolve to catalog copy; everything else, including a code added after this
  build shipped, becomes one generic message. The raw code is never shown.
- **`src/db/repositories/thresholdsRepository.ts`** — the offline cache behind
  `GET /api/v1/thresholds`. Deliberately unseeded; see its header.

### Still owed

- **§5.4's `CURSOR_TOO_OLD` recovery is reported, not performed.** The worker
  stops with `cursor-too-old` and halts scheduling. Wiping local entity state
  and re-syncing from `since=0` destroys local rows — including queued,
  unpushed ones — so it needs a screen and a decision, not a background task.
- **The entry timestamp can be reset to now but not freely edited.** A date and
  time picker is the remaining piece of AC 2.1 AC3; the Tier 1 bounds that
  govern it are implemented and tested.
- **No surgery-date bound.** There is no local profile table yet, so
  `EFFECTIVE_DATE_TIME_BEFORE_SURGERY` is enforced server-side only. It lands
  here at P4.S1 when onboarding captures the date.

## What the test suite cannot prove about this app

jest runs no keychain, cannot simulate a biometric enrolment change, and has
no backup transport, so the device-side controls this app carries —
ADR-0014's SQLCipher store and device binding, ADR-0015's
`requireAuthentication` invalidation and Class 3 requirement — are unproven
by a green `pnpm test`. The emulator harness
(`.claude/skills/android-emulator/SKILL.md`) exercises their logic and not
the hardware guarantees underneath.

`docs/gate-b-hardware-verification.md` is the standing list of what closes
that gap: HW-1 to HW-10, each with its procedure, its pass condition, and
what its failure would mean. None have been run. Do not describe any of
these controls as verified until a step there is closed with a recorded run.

## What this app must never do

See `docs/sync-contract.md` §9 in full. The two most load-bearing for this
skeleton: never confirm a save from a network response (§9.5 — the local
write already is the confirmation), and never store a token or PHI in
`AsyncStorage` — only `expo-secure-store`, and only the refresh token, never
an access token or any clinical value.

## Why `@react-native/metro-config` is a devDependency here

It is not imported by any code in this app. It is declared so that pnpm
resolves `react-native-worklets`' peer requirement from a **dev** section
rather than auto-linking it into the production dependency graph, where
`pnpm audit --prod` then walks `metro -> image-size` and blocks CI on two
high advisories that have no patched version at any point on the range.

Metro is the bundler: it runs on a developer machine or in EAS Build and
never ships in the binary. Declaring it as dev tooling is accurate, and it
means no advisory has to be suppressed by ID for the gate to pass.

**Its version must track `react-native` exactly** (both are 0.86.3 today).
It is pinned, not a caret range, because `@react-native/metro-config` ships
per React Native release and nothing in this repo would catch a mismatch —
jest-expo does not run Metro, so the suite passes with a bundler config out
of step with the runtime it configures and the failure appears on the next
EAS build. Bump the two together.
