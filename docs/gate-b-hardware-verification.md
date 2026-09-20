# Gate B: the steps that need a physical device

Gate B is the first demonstrable milestone ([`v1-implementation-plan.md`](../design-specs/planning/v1-implementation-plan.md)): one live walkthrough on the dev host, from an entry made in airplane mode to that entry rendered in the web view. Most of it runs on an emulator, and `.claude/skills/android-emulator/SKILL.md` is how.

This document is the remainder — the checks that exist to prove the **device-side controls**, the ones `CLAUDE.md` summarises as "none of the mobile device-side controls are verified on hardware". They are a standing open item rather than a sprint task, and they stay open until someone runs them on real handsets and records the result at the bottom of this file.

Every step has an ID. Cite it — "HW-6 is still open" — instead of re-describing the check each time it comes up.

## Why an emulator cannot close them

The Android emulator reports `android.hardware.fingerprint` and a `hardware_keystore`, but never `android.hardware.strongbox_keystore`: it is KeyMint in software. It has no Play Services backup transport, no second physical handset to restore a backup onto, no Class 2-only face sensor, and no iOS at all. It therefore exercises the _logic_ of [ADR-0014](../design-specs/decisions/0014-local-phi-encryption-and-device-ownership.md) and [ADR-0015](../design-specs/decisions/0015-biometric-local-access.md) and says nothing about the hardware guarantees those decisions rest on.

Record an emulator pass as "exercised on an emulator". It never closes a step here, and it is never grounds for editing CLAUDE.md's caveat.

## What the emulator already discharges — do not repeat here

Sign-in, SQLCipher opening the store, the subject-binding purge, the unsent-entry warning on sign-out, the offline entry → queue → push → audit row → web view path, and — after `scripts/android-emulator.sh fingerprint` — Android biometric enrolment, unlock and rejection. Re-running these on a handset is harmless, but they are not what is open.

## Blockers to running these at all

**There is no iOS build path in this repo.** No `eas.json`, no macOS in the loop, and `apps/mobile` has never been built for iOS. HW-4, HW-5, HW-6b, HW-9 and HW-10 are blocked until one exists — a macOS machine with Xcode, or an EAS Build account. That choice is not made here, but nothing on the iOS half of this list can be scheduled before it is.

**Android needs a development build on the handset**, not Expo Go. `app.json` turns SQLCipher on through the `expo-sqlite` config plugin; Expo Go would run with an unencrypted store and prove the opposite of what these steps are for.

**Three steps need hardware we may not have**: HW-3 a device with a Google account and backup enabled; HW-4 two iPhones; HW-7 an Android handset whose only enrolled biometric is Class 2 face unlock.

**Networking.** On a USB-attached Android handset, `adb reverse tcp:3000 tcp:3000` and `tcp:8090` keep `localhost` identical on both sides, exactly as the emulator harness does. Over Wi-Fi — and on iOS, where `adb reverse` does not exist — point `.env`'s `DEV_HOST_ADDRESS` and `apps/mobile/.env` at the host's LAN address, the **same value on both sides**. mock-oauth2-server mints `iss` from the Host header the client used and `apps/api` compares it by exact string equality, so a mismatch presents as a clean sign-in followed by a bare 401 on every call — which reads as a broken auth guard and is not.

**Synthetic data only.** A test handset is as much "outside production" as the dev host is. Nothing about holding a real phone relaxes that rule.

## The steps

### HW-1 — the database on disk is ciphertext, and the key is not lying beside it

ADR-0014. On a debuggable development build:

```
adb shell run-as org.ostomy.diary
head -c 16 databases/<db-file>        # must NOT be "SQLite format 3\0"
sqlite3 databases/<db-file> .tables   # must refuse
grep -ri <leading bytes of the hex key> files/ shared_prefs/ cache/ databases/
```

**Pass:** the header is not SQLite's, `sqlite3` refuses the file, and the 64-character hex key appears nowhere in the app sandbox — it is in the keystore, which `run-as` does not reach.

**A failure means** SQLCipher is not actually on for this build, and ADR-0014's breach-notification safe-harbour argument does not hold for any handset that has run it.

### HW-2 — record what backs the key on this device

No supported API proves the app's _own_ key sits in secure hardware: `expo-secure-store` exposes no security level, and reading Android's `KeyInfo.isInsideSecureHardware` needs a native module nobody has written. So this step records the handset's capability, not the key's placement:

```
adb shell pm list features | grep -E 'strongbox|hardware_keystore'
```

**Pass:** the capability and the handset model are written down, alongside the explicit statement that this is device evidence and not key evidence.

This is the weakest item in the list and should be labelled that way rather than quietly counted. The two honest ways out are to write the native probe, or to keep stating the limit.

### HW-3 — Android: the app is out of Google backup

`app.json` sets `allowBackup: false`. On a handset signed into a Google account with backup enabled:

```
adb shell bmgr enabled
adb shell bmgr backupnow org.ostomy.diary
```

**Pass:** the package is reported as not eligible for backup.

**A failure means** the diary is being copied into the patient's personal Google account — a destination that can never appear on SRS_v2 §4.6's covered-service list, because Google does not execute a BAA for consumer backup.

### HW-4 — iOS: a backup restored onto a _second_ phone yields nothing readable

This is the step that carries ADR-0014's accepted gap. `expo-file-system@57` removed `setIsExcludedFromBackupAsync`, so the database does enter iCloud and Finder backups. What makes that acceptable is the pairing of SQLCipher with an `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` key the keychain does not migrate. Until this runs, that pairing is an argument, not evidence.

Make entries on phone 1; take an encrypted Finder backup; restore it onto phone 2; launch the app.

**Pass:** phone 2 demands a full OIDC sign-in — the refresh token is `_THIS_DEVICE_ONLY` and must not have migrated — and no prior entry is readable on it.

**A failure means** the iOS backup-exclusion config plugin stops being defence in depth and becomes required work.

### HW-5 — iOS: a backup restored onto the _same_ phone still works

The converse of HW-4, and not the same test. ADR-0014 claims a same-device restore still decrypts, because that is where the keychain item survives.

**Pass:** after restoring phone 1's backup onto phone 1, the diary opens and prior entries are present.

**A failure means** a patient who restores their own phone loses their whole diary with no message saying so — SQLCipher reports a wrong key as a generic "file is not a database".

### HW-6 — a biometric enrolment change invalidates the stored token

The centre of ADR-0015, and the one OS guarantee this design depends on and has never observed.

- **6a Android:** enrol one fingerprint, sign in, add a second fingerprint in Settings, cold-start the app.
- **6b iOS:** enrol Face ID, sign in, reset Face ID, cold-start the app.

**Pass, both halves:** the stored refresh token is unreadable and the app routes to a full OIDC sign-in, **and the local diary survives**. ADR-0014 deliberately leaves `requireAuthentication` off the database key so that adding a fingerprint never costs the patient unsynced entries; the second half is the one that is easy to forget and expensive to get wrong.

**Expect the first half to fail as currently built.** From the code rather than from a run: `AuthContext.unlock()` reads the token inside a `try` whose `catch` is deliberately silent, and `hasStoredRefreshToken()` answers from a separate non-authenticated marker that an invalidation does not clear. An invalidated token therefore looks like an ordinary failed refresh — the app unlocks, reports an authenticated session, holds no access token, syncs nothing, and offers no route to the sign-in screen. If a handset confirms that, it is a defect in `AuthContext.tsx`/`tokenStorage.ts`, not a finding about the OS, and ADR-0015's "forces a full OIDC re-login" describes an intention the build does not implement.

### HW-7 — a Class 2-only handset falls back to the passcode instead of dead-ending

`isBiometricUnlockAvailable()` asks `isEnrolledAsync()`, which does not discriminate biometric class, while `authenticate()` demands `biometricsSecurityLevel: 'strong'`. On a handset whose only enrolment is Class 2 face unlock, the app therefore offers an unlock the OS may refuse to satisfy. `disableDeviceFallback` is left at its default precisely so the device credential is there to catch this.

**Pass:** the patient reaches the device-credential prompt and gets into the app.

**A failure means** those patients cannot open their own diary. ADR-0015 accepted pushing Class 2 handsets to the passcode; it did not accept locking them out.

### HW-8 — a biometric lockout is not a dead end, and sign-out still works inside one

Fail the sensor enough times to trigger the OS lockout, then check two things.

**Pass:** (a) the device-credential path still opens the app; (b) **sign-out still purges** — the token is cleared and the database file is gone. `signOut()` guards its token read for exactly this state, because an unguarded read previously let a patient hand over a phone with the refresh token and the entire diary still on it while the UI reported a signed-out session. Lockout is the cheapest way to reach that state on real hardware.

### HW-9 — iOS: how many prompts the patient actually sees

ADR-0015 records the create/read asymmetry as a polish regression nobody has watched, and `tokenStorage.ts`'s marker key exists because an earlier build showed the OS sheet before the app had rendered its own unlock affordance, and then prompted a second time.

Record what the patient sees, in order, at: first login, cold start, unlock, sign-out.

**Pass:** no sheet before the app has rendered, exactly one sheet at the cold-start unlock, and none when the token is stored at login.

### HW-10 — iOS: the OS kills the app in the background with entries queued

`docs/testing.md` requires that queued data survives app restart and OS background termination. jetsam is not modelled by an emulator, and the simulator's approximation is not worth trusting.

Queue entries offline, background the app, force the OS to reclaim it, relaunch.

**Pass:** the lock gate appears rather than the previous screen, every queued entry is still present, and they push when connectivity returns.

## Recording a result

A step is closed by a recorded run naming the handset, the OS version, the build, and the outcome — not by an argument that it ought to work. Add a row below, keep the failures, and open a fix rather than editing the step to match what happened.

When every step is closed, CLAUDE.md's "none of the mobile device-side controls are verified on hardware" is the sentence to change, in the same commit.

| Step           | Device | OS  | Build | Date | Outcome |
| -------------- | ------ | --- | ----- | ---- | ------- |
| _none run yet_ |        |     |       |      |         |
