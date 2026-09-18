---
name: android-emulator
description: "Run apps/mobile on an Android emulator (Pixel 8) against the local dev stack, for on-device testing and debugging that jest cannot do. Triggers on: 'emulator', 'AVD', 'Pixel 8', 'run the app on a device', 'adb', 'logcat', 'dev build', 'test on Android', 'biometric test', 'Gate B', 'sync on a real device'."
---

# Running `apps/mobile` on an Android emulator

`scripts/android-emulator.sh` is the tool; this skill is the judgement around it.
Read the script's header before changing anything in it — it records why the
networking is shaped the way it is.

```
scripts/android-emulator.sh doctor       what's installed, what's missing
scripts/android-emulator.sh up           create + boot + wire  (idempotent)
scripts/android-emulator.sh status       device state, forwarded ports, app installed?
scripts/android-emulator.sh logcat       this app's process only
scripts/android-emulator.sh fingerprint  device PIN + fingerprint enrolment
scripts/android-emulator.sh wipe         factory-reset data, then cold boot
scripts/android-emulator.sh stop
```

Equivalent pnpm entry points exist (`pnpm --filter @ostomy/mobile emulator:*`)
for people who do not use this skill.

## Always start with `doctor`

It is cheap and it is the only thing that distinguishes "the emulator is
broken" from "this machine cannot build the app yet". Two different failures
look identical at the Gradle prompt, and `doctor` names which one you have.

The emulator half and the build half have **separate** prerequisites. The
emulator runs with just `platform-tools` + `emulator` + a system image. The
development build additionally needs a JDK, SDK platform `android-36`, and an
NDK. So `doctor` exiting non-zero does not mean `up` will fail — read which
section failed.

## Do not expect Expo Go to work

`app.json` turns on SQLCipher through the `expo-sqlite` config plugin
(ADR-0014). That is a native change, so the app only runs as a **development
build**:

```bash
pnpm --filter @ostomy/mobile android:build   # expo run:android — prebuilds + compiles + installs
pnpm --filter @ostomy/mobile start --port 8082   # afterwards, to attach Metro
```

`android` (`expo start --android`) is **not** that — it only opens the dev
server against whatever is already installed, so it is the second step, never
the first. Expo Go will either refuse or, worse, run with an unencrypted store
and prove nothing. If someone reports "it works in Expo Go", that is the bug.

## The networking is the part that goes wrong

Use `adb reverse` (what `wire` does). Never `10.0.2.2`, and never edit
`apps/mobile/.env` to point at a LAN address for an emulator.

The reason is specific and verified, not stylistic. `mock-oidc` derives its
advertised `issuer` from the request's Host header:

| Device reaches the IdP as | advertised `issuer` |
|---|---|
| `localhost:8090` (via `adb reverse`) | `http://localhost:8090/patient-issuer` |
| `10.0.2.2:8090` | `http://10.0.2.2:8090/patient-issuer` |

`apps/api` validates `iss` against its own `OIDC_ISSUER`, which is
`http://localhost:8090/patient-issuer`. With `10.0.2.2` the sign-in flow
completes, the app receives a token, and then **every API call returns a bare
401** — a failure that looks like a broken auth guard and is not. `adb reverse`
keeps the hostname identical on both sides, which is what lets
`apps/mobile/.env.example` work unmodified.

`wire` forwards only `3000` (api) and `8090` (mock-oidc). It deliberately does
not forward MinIO's console or the admin SPA: a patient device has no business
reaching either, and forwarding them would let a device-side bug reach a
surface the real topology denies it.

### Metro collides with the admin SPA on 8081

`infra/docker-compose.yml` publishes host `8081` for `admin`, which is also
Metro's default port. Expo then silently picks another port and the device
cannot find the bundler. `wire` detects this and prints the fix:

```bash
pnpm --filter @ostomy/mobile start --port 8082
adb -s emulator-5554 reverse tcp:8082 tcp:8082
```

## Before you conclude anything from a run

**The stack must be up and seeded.** `docker compose --env-file .env -f
infra/docker-compose.yml up -d`, and `scripts/dev-reset.sh` if you need the
synthetic scenario. An emulator talking to a stack with no data produces empty
screens that look like client bugs.

**Synthetic data only.** Nothing about running on a device relaxes CLAUDE.md's
rule: no real PHI outside production, not temporarily, not to reproduce a bug.
The emulator's disk is as much "outside production" as the dev host is.

## Debugging

`logcat` scopes to this app's process rather than the whole ring buffer. That
narrowness is the point: this app's rule is that **no clinical value is ever
logged**, so a volume or a meal description appearing in `logcat` is a finding
to report, not noise to scroll past.

**You cannot read the local database.** It is SQLCipher-encrypted with a key in
the Android keystore (ADR-0014). `adb shell run-as org.ostomy.diary` will hand
you the file and `sqlite3` will refuse it, correctly. Debug the local store
through the app's own code paths and the jest suite, which runs against Node's
built-in SQLite — not by prying the file open. If you find a way to read it
without the keystore, that is a security defect worth reporting.

## What the emulator does and does not prove

It genuinely exercises things jest cannot: the real SQLCipher store, Expo
Router navigation, the OIDC browser redirect, the sync worker against a real
API over a real socket, backgrounding and foregrounding, and — after
`fingerprint` — biometric enrolment, unlock, rejection and
enrolment-invalidation.

It does **not** discharge the "verified on hardware" caveat in CLAUDE.md. The
emulator reports `android.hardware.fingerprint` and a `hardware_keystore`, but
no `android.hardware.strongbox_keystore` — it is KeyMint in software. So it
tests the *logic* of ADR-0014 and ADR-0015, not the hardware guarantee they
rest on. Say "exercised on an emulator", never "verified on hardware", and do
not edit CLAUDE.md's caveat on the strength of an emulator run.

Same for iOS: this covers Android only. Nothing here says anything about
Keychain accessibility or Face ID.

## Testing a fresh install

`wipe` factory-resets the device. Reach for it when the test *is* first-run
state — ADR-0014 binds the encrypted store to one OIDC subject and destroys it
when a different subject signs in, and a device carrying a previous run's store
cannot honestly test that. A reinstall is not equivalent: it leaves the
keystore populated.

## Gate B

This unblocks the emulator-testable part of Gate B's phone-dependent steps.
Record the result as an emulator walkthrough. The steps that exist to prove
hardware-backed key behaviour still need a physical device on a dev build —
resolve those as still-open rather than closing them from an emulator pass.
