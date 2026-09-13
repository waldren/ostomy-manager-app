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
pnpm ios                # expo start --ios
pnpm android            # expo start --android
pnpm typecheck          # tsc --noEmit
pnpm test               # jest (jest-expo preset — docs/testing.md)
pnpm test:watch
```

`pnpm verify` at the repo root runs this app's `typecheck` and `test` (via
`pnpm -r --if-present run <script>`) alongside every other workspace, plus
lint and format over `apps/mobile/**`.

Copy `.env.example` to `.env` before running `start`/`ios`/`android` — see
that file for what each variable means and the OIDC audience assumption this
sprint records.

## Architecture notes for the next sprint (P2.S2b)

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
- `src/db/repositories/syncQueueRepository.ts` holds the queue shape
  `docs/sync-contract.md` §3.1 requires of a push operation, including the
  enqueue-time `operation_id` (minted once, never reused — §3.7, §9.7) and a
  `rejected` status that **retains** the row for correction rather than
  removing it (§3.5, §9.1) — the seam the correction inbox builds on.
- `src/db/offlineWrites.ts`'s `enqueueObservationCreate` /
  `enqueueObservationUpdate` / `enqueueObservationDelete` are the local
  write-then-enqueue transaction the Add Output screen should call directly
  rather than re-deriving: both inserts commit together via
  `SqliteExecutor.withTransactionAsync`, matching the "local write is the
  save confirmation" rule.
- `src/auth/AuthContext.tsx` exposes `phase: 'checking' | 'signedOut' |
  'locked' | 'authenticated'` and treats a successful biometric unlock as
  sufficient for **local** app access regardless of whether the subsequent
  refresh-token network call succeeds — see that file's header comment. A
  missing/expired access token should only ever block a sync network call
  (P2.S2b), never local entry.
- No sync push/pull worker exists yet. `src/db/repositories/syncQueueRepository.ts`'s
  `listQueuedOperations` already returns rows in enqueue order, which
  coincides with non-descending `clientTimestamp` order under normal clock
  behaviour — but `docs/sync-contract.md` §3.2 still requires detecting a
  clock-correction discontinuity and splitting the batch there before a push;
  that detection has not been written and is P2.S2b's obligation, not this
  repository's.

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
