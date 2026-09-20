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

## Run it from Git Bash, not PowerShell

On Windows the bare word `bash` resolves to `C:\Windows\System32\bash.exe` —
**WSL** — when invoked from PowerShell or cmd, including through
`pnpm --filter @ostomy/mobile emulator:*`. WSL has no access to the Windows
Android SDK, starts a second adb server that cannot see the Windows one's
devices, and (by default) has neither `git` nor `LOCALAPPDATA`.

The script detects this and says so rather than half-working. If you see it,
either run from Git Bash, or point npm at Git Bash once:

```
npm config set script-shell "C:\Program Files\Git\bin\bash.exe"
```

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
pnpm --filter @ostomy/mobile android          # expo run:android — prebuild + compile + install
```

Expo Go will either refuse or, worse, run with an unencrypted store and prove
nothing. If someone reports "it works in Expo Go", that is the bug.

`expo prebuild` generates `apps/mobile/android/`. It is **build output** —
gitignored, and ignored by Prettier and ESLint too, since both walk the
filesystem rather than git. Never commit it and never hand-edit it: `app.json`
and the config plugins are the source of truth for the native project, and a
checked-in `android/` forks silently from them. The plugin enabling SQLCipher
is exactly the thing you do not want to learn about from a stale Gradle file.

### Three things that will bite on a first build

**Use a JDK between 17 and 21.** Android Studio bundles JDK 25 and AGP 8.12
(what React Native 0.86 pins) cannot drive CMake on it — JEP 472's
restricted-method enforcement fails every native module at configure time with
`WARNING: A restricted method in java.lang.System has been called`, which names
neither the JDK nor the real cause. Gradle usually has a usable JDK already at
`~/.gradle/jdks/`. `doctor` finds it and prints the `export JAVA_HOME=...` line.

**`--device` takes the AVD name, not the adb serial.** `--device Pixel_8`
works; `--device emulator-5554` fails with `Could not find device with name`.

**A transient `Read timed out` from dl.google.com is not a real failure.**
Gradle keeps what it cached — just run it again.

## Why the repo installs hoisted

`.npmrc` sets `node-linker=hoisted`, and that exists for this build. pnpm's
default layout makes the native build impossible on Windows two ways at once:
object-file paths blow past CMake's 250-character limit inside
`.pnpm/<name>@<version>_<hash>/`, and the symlinks into that store leave ninja's
manifest permanently dirty (`still dirty after 100 tries`).

The cost is real and worth remembering: hoisting lets a workspace import a
package it never declared, and nothing catches that. It also forces the repo
onto **one** React version — `pnpm.overrides` pins react and react-dom to
19.2.3, Expo SDK 57's pin. Do not raise that except in step with an Expo
upgrade: a second React copy does not error, it renders nothing, which cost
`packages/ui` 21 silently-failing tests to diagnose.

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
adb -s emulator-5554 reverse tcp:8081 tcp:8082
```

**Note the ports do not match, and that is the point.** An already-built
development build has `localhost:8081` baked in as its bundler URL and will ask
for 8081 no matter where Metro is listening. Reversing `8082 -> 8082` leaves it
asking 8081, reaching the admin SPA, and dying with "Unable to load script".
Mapping the device's 8081 to the host's 8082 puts Metro where the app already
looks, and leaves the admin container alone. (Found in R.S1.)

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

**The OIDC redirect only counts if the AVD has a Custom Tabs provider.** The
`default` system image ships none — `com.android.webview` and the Chromium
shell, no Chrome — so `WebBrowser.openAuthSessionAsync` has nothing to open and
sign-in cannot complete. `SYSTEM_IMAGE_TAG` is `google_apis` for that reason
(R.S1); if you point this harness at a `default` image, strike the OIDC
redirect off the list above.

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

Those steps are written out as HW-1 to HW-10 in
`docs/gate-b-hardware-verification.md`, with what each one proves and what its
failure would mean. That document also lists what an emulator run already
discharges, so a walkthrough here does not repeat them. Cite a step by its ID.
