# Gate B: the steps that need a physical device

Gate B is the first demonstrable milestone ([`v1-implementation-plan.md`](../design-specs/planning/v1-implementation-plan.md)): one live walkthrough on the dev host, from an entry made in airplane mode to that entry rendered in the web view. Most of it runs on an emulator, and `.claude/skills/android-emulator/SKILL.md` is how.

This document is the remainder — the checks that exist to prove the **device-side controls**, the ones `CLAUDE.md` summarises as "none of the mobile device-side controls are verified on hardware". They are a standing open item rather than a sprint task, and they stay open until someone runs them on real handsets and records the result at the bottom of this file.

Every step has an ID. Cite it — "HW-6 is still open" — instead of re-describing the check each time it comes up.

**v1 ships Android only ([ADR-0020](../design-specs/decisions/0020-android-only-v1.md)), so the in-scope steps are HW-1, HW-2, HW-3, HW-6, HW-7, HW-8, HW-10 and HW-11.** HW-4, HW-5 and HW-9 are iOS-specific and are marked out of scope below rather than deleted: they are the list iOS reinstatement starts from, and deleting them would mean rediscovering it. The IDs never move — issue #39 and the implementation plan both cite them by number.

## Why an emulator cannot close them

The Android emulator reports `android.hardware.fingerprint` and a `hardware_keystore`, but never `android.hardware.strongbox_keystore`: it is KeyMint in software. It has no Play Services backup transport, no Class 2-only face sensor, and it reclaims nothing under memory pressure. It therefore exercises the _logic_ of [ADR-0014](../design-specs/decisions/0014-local-phi-encryption-and-device-ownership.md) and [ADR-0015](../design-specs/decisions/0015-biometric-local-access.md) and says nothing about the hardware guarantees those decisions rest on.

Record an emulator pass as "exercised on an emulator". It never closes a step here, and it is never grounds for editing CLAUDE.md's caveat.

## What the emulator already discharges — do not repeat here

Sign-in, SQLCipher opening the store, the subject-binding purge, the unsent-entry warning on sign-out, the offline entry → queue → push → audit row → web view path, and — after `scripts/android-emulator.sh fingerprint` — Android biometric enrolment, unlock and rejection. Re-running these on a handset is harmless, but they are not what is open.

## Blockers to running these at all

**The iOS steps are out of scope, not blocked.** There is no `eas.json`, no macOS in the loop, and `apps/mobile` has never been built for iOS — which is why v1 now ships Android only ([ADR-0020](../design-specs/decisions/0020-android-only-v1.md)). HW-4, HW-5 and HW-9 are retained for the phase that reinstates the platform, and nothing on this list waits on them.

**Android needs a development build on the handset**, not Expo Go. `app.json` turns SQLCipher on through the `expo-sqlite` config plugin; Expo Go would run with an unencrypted store and prove the opposite of what these steps are for.

**Two steps need hardware we may not have**: HW-3 a handset signed into a Google account with backup enabled; HW-7 a handset whose only enrolled biometric is Class 2 face unlock.

**Networking.** On a USB-attached handset, `adb reverse tcp:3000 tcp:3000` and `tcp:8090` keep `localhost` identical on both sides, exactly as the emulator harness does. Over Wi-Fi, point `.env`'s `DEV_HOST_ADDRESS` and `apps/mobile/.env` at the host's LAN address, the **same value on both sides**. mock-oauth2-server mints `iss` from the Host header the client used and `apps/api` compares it by exact string equality, so a mismatch presents as a clean sign-in followed by a bare 401 on every call — which reads as a broken auth guard and is not.

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

### HW-4 — iOS: a backup restored onto a _second_ phone yields nothing readable — OUT OF SCOPE (v1 is Android only)

> Retained for the phase that reinstates iOS ([ADR-0020](../design-specs/decisions/0020-android-only-v1.md)). Nothing in v1 waits on it, and it must not be counted as open work.

This is the step that carries ADR-0014's accepted gap. `expo-file-system@57` removed `setIsExcludedFromBackupAsync`, so the database does enter iCloud and Finder backups. What makes that acceptable is the pairing of SQLCipher with an `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` key the keychain does not migrate. Until this runs, that pairing is an argument, not evidence.

Make entries on phone 1; take an encrypted Finder backup; restore it onto phone 2; launch the app.

**Pass:** phone 2 demands a full OIDC sign-in — the refresh token is `_THIS_DEVICE_ONLY` and must not have migrated — and no prior entry is readable on it.

**A failure means** the iOS backup-exclusion config plugin stops being defence in depth and becomes required work.

### HW-5 — iOS: a backup restored onto the _same_ phone still works — OUT OF SCOPE (v1 is Android only)

> Retained for the phase that reinstates iOS ([ADR-0020](../design-specs/decisions/0020-android-only-v1.md)). Nothing in v1 waits on it, and it must not be counted as open work.

The converse of HW-4, and not the same test. ADR-0014 claims a same-device restore still decrypts, because that is where the keychain item survives.

**Pass:** after restoring phone 1's backup onto phone 1, the diary opens and prior entries are present.

**A failure means** a patient who restores their own phone loses their whole diary with no message saying so — SQLCipher reports a wrong key as a generic "file is not a database".

### HW-6 — a biometric enrolment change invalidates the stored token

The centre of ADR-0015, and the one OS guarantee this design depends on and has never observed.

Enrol one fingerprint, sign in, add a second fingerprint in Settings, cold-start the app.

(This step was HW-6a while iOS was in scope. Its iOS half, HW-6b, is retained in ADR-0020's reinstatement list and is not open work. Older references to "HW-6a" mean this step; issue #39 now cites it as HW-6.)

**Pass, both halves:** the stored refresh token is unreadable and the app routes to a full OIDC sign-in, **and the local diary survives**. ADR-0014 deliberately leaves `requireAuthentication` off the database key so that adding a fingerprint never costs the patient unsynced entries; the second half is the one that is easy to forget and expensive to get wrong.

**This step used to say "expect the first half to fail", and that prediction was right.** `AuthContext.unlock()` read the token inside a `try` whose `catch` was deliberately silent, and `hasStoredRefreshToken()` answers from a separate non-authenticated marker that an invalidation does not clear — so an invalidated token looked like an ordinary failed refresh: the app unlocked, reported an authenticated session, held no access token, synced nothing, and offered no route to the sign-in screen. `SyncProvider` gates on that phase, so the worker also ran on a timer with no credential and was refused every time. Fixed under **#40**, in two halves that are worth checking separately here:

- An invalidated key reads as nothing, and `unlock()` now treats a missing token as a session that is over: it purges and routes to sign-in with `login.unlockChanged*`.
- A refresh the issuer **rejects** (`invalid_grant`) is told apart from one that merely failed, and ends the session with `login.sessionEnded*`. A network failure or a 5xx still keeps the session, deliberately.

So the step now verifies a fix rather than an expected failure. **A failure here is a regression in `AuthContext.tsx`/`tokenStorage.ts`, not a finding about the OS** — and if the app reaches the home screen with sync permanently dead, that is precisely #40 returning.

### HW-7 — a Class 2-only handset falls back to the passcode instead of dead-ending

`authenticate()` demands `biometricsSecurityLevel: 'strong'`, so on a handset whose only enrolment is Class 2 face unlock the OS may refuse the biometric. `disableDeviceFallback` is left at its default precisely so the device credential is there to catch this.

This step used to describe the availability check as the risk — it asked `isEnrolledAsync()`, which does not discriminate biometric class. That prediction was right and the dead-end turned out to be wider than Class 2: it caught every handset with no biometric enrolled at all. Fixed under #74, so the step is now checking a fix rather than an expected failure. `isLocalUnlockAvailable()` asks `getEnrolledLevelAsync() !== NONE`.

**Pass:** the patient reaches the device-credential prompt and gets into the app.

**A failure means** those patients cannot open their own diary. ADR-0015 accepted pushing Class 2 handsets to the passcode; it did not accept locking them out.

### HW-8 — a biometric lockout is not a dead end, and sign-out still works inside one

Fail the sensor enough times to trigger the OS lockout, then check two things.

**Pass:** (a) the device-credential path still opens the app; (b) **sign-out still purges** — the token is cleared and the database file is gone. `signOut()` guards its token read for exactly this state, because an unguarded read previously let a patient hand over a phone with the refresh token and the entire diary still on it while the UI reported a signed-out session. Lockout is the cheapest way to reach that state on real hardware.

### HW-9 — iOS: how many prompts the patient actually sees — OUT OF SCOPE (v1 is Android only)

> Retained for the phase that reinstates iOS ([ADR-0020](../design-specs/decisions/0020-android-only-v1.md)). Nothing in v1 waits on it, and it must not be counted as open work.

ADR-0015 records the create/read asymmetry as a polish regression nobody has watched, and `tokenStorage.ts`'s marker key exists because an earlier build showed the OS sheet before the app had rendered its own unlock affordance, and then prompted a second time.

Record what the patient sees, in order, at: first login, cold start, unlock, sign-out.

**Pass:** no sheet before the app has rendered, exactly one sheet at the cold-start unlock, and none when the token is stored at login.

### HW-10 — Android: the OS kills the app in the background with entries queued

`docs/testing.md` requires that queued data survives app restart and OS background termination. An emulator with generous memory and no competing apps rarely reclaims anything, so it does not exercise this — which is the point of running it on a real handset under real memory pressure.

Queue entries offline, background the app, then force the reclaim: `adb shell am kill org.ostomy.diary` for the deterministic case, and Developer options' **Don't keep activities** plus ordinary heavy app use for the realistic one. Run both — the first proves the store survives, the second proves the app comes back to the right place after the OS took it without warning. Relaunch.

**Pass:** the lock gate appears rather than the previous screen, every queued entry is still present, and they push when connectivity returns.

**A failure means** the patient loses entries they were told were saved, which is what `sync-contract.md` §9.5 exists to prevent.

### HW-11 — a handset with NO biometric enrolled can sign in, use the diary offline, and is invalidated when one appears

Issue #74 and [ADR-0015](../design-specs/decisions/0015-biometric-local-access.md)'s amendment. This is the state nothing had tested: jest runs no keychain, and the emulator used for the earlier walkthroughs had a fingerprint enrolled, which is exactly why the bug survived. The absence of an enrolment has to be arranged deliberately — it is not a state you arrive at by accident.

Start from a wiped device with **a screen lock set and no biometric enrolled** (`android-emulator.sh wipe`, then set a PIN only). Three parts, in order, on one device:

1. **Sign in.** Complete the OIDC flow.
2. **Cold-start and open the diary with the PIN**, offline. Turn the radios off first, so nothing can succeed by reaching the network.
3. **Enrol a fingerprint in Settings, then cold-start again.**

**Pass, all three:**

1. Sign-in completes and reaches the home screen. Before #74 it failed here with `Could not Authenticate the user: No biometrics are currently enrolled`, showing the patient "We could not sign you in. Please try again." — so this part alone is the regression test for the reported defect.
2. The lock screen offers **Unlock my diary**, the device-credential prompt appears, and the diary opens with the network off. What must NOT happen is the screen offering only "Sign in again instead": that is a network login, and offering it to an offline patient is the second defect #74 fixed.
3. The app routes to a **full OIDC sign-in** rather than unlocking, **and the local diary survives** — same two halves as HW-6, for the same ADR-0014 reason. This is the reimplemented invalidation signal, so a pass here is the only evidence that it works: the level rise is detected at cold start, the ungated token is purged, and the token stored by the re-login is gated.

**A failure in part 3 specifically** means an ungated token outlives the enrolment that should have killed it, which is ADR-0015's covert-enrolment threat left open rather than closed by a different mechanism. Report it against the amendment, not against the OS — nothing here depends on an OS guarantee, which is the whole reason it needs observing.

**Part 4, and it needs different hardware: a handset with NO biometric sensor at all.** An AVD reports biometric hardware, so the emulator cannot produce this state and neither can parts 1 to 3. The first fix for #74 gated the enrolment level on `hasHardwareAsync()` — which reports whether a *scanner* exists — and so locked every sensorless phone out of its own offline diary while reporting "This phone does not have face, fingerprint, or passcode unlock turned on", which was false. **Pass:** with a PIN set and no sensor, the patient reaches the device-credential prompt from **Unlock my diary** and opens the diary offline. Cheap Android handsets and many tablets are this configuration, and it skews toward this patient population rather than away from it.

**Part 5.** Enrol a fingerprint, sign in, then REMOVE the fingerprint in Settings and open the app. **Pass:** the passcode unlock works and the app either syncs or routes to a sign-in explaining it — what must NOT happen is reaching the home screen with sync silently dead forever. That is a gated token whose key the OS invalidated, and it became reachable only once local unlock started accepting the passcode.

**Also record** whether the patient is shown anything about the weaker protection. Nothing is shown today, deliberately (no copy was invented for it), and a run is the first chance to judge whether that is right.

## Recording a result

A step is closed by a recorded run naming the handset, the OS version, the build, and the outcome — not by an argument that it ought to work. Add a row below, keep the failures, and open a fix rather than editing the step to match what happened.

When every **in-scope** step is closed — HW-1, HW-2, HW-3, HW-6, HW-7, HW-8, HW-10, HW-11 — CLAUDE.md's "none of the mobile device-side controls are verified on hardware" is the sentence to change, in the same commit. The out-of-scope iOS steps do not hold it open.

| Step           | Device | OS  | Build | Date | Outcome |
| -------------- | ------ | --- | ----- | ---- | ------- |
| _none run yet_ |        |     |       |      |         |
