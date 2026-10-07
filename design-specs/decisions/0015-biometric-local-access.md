# ADR-0015: The device passcode or a biometric unlocks local data, as peers

- **Status:** Accepted (amended 2026-09-25 and **2026-10-07** — read both amendments; the second one CHANGES the decision rather than extending it)
- **Date:** 2026-09-12
- **Deciders:** Steven Waldren
- **Related:** SRS_v2 §4.2, §5.2 | [ADR-0014](0014-local-phi-encryption-and-device-ownership.md) | PR #15 | issue #74 | issues #116, #117

## Context

`apps/mobile` is offline-capable by design, and the use case is explicit in the code that implements it: patients log stoma output in public restrooms and while travelling. Unlock therefore cannot require a network round trip to the issuer — an app that will not open without connectivity is an app that loses the entry.

That settles one question and appears to settle a second. It does not. Two decisions were being made at once under a single heading, and only the first is justified by the offline rationale:

1. **Does unlocking require contacting the issuer?** No — for the reason above.
2. **Does the app forfeit the operating system's biometric-enrolment invalidation signal?** This is separate, and the offline argument says nothing about it.

The initial implementation answered the second question "yes" by declining `expo-secure-store`'s `requireAuthentication` option, gating instead at the application layer so the prompt copy would be the app's own rather than the OS default. That is a real and reasonable UX concern. Its cost was not examined.

The cost is specific. `expo-local-authentication` exposes only current state — `hasHardwareAsync`, `isEnrolledAsync`, `getEnrolledLevelAsync` — and no change signal whatsoever, so an app cannot detect at its own layer that a second fingerprint or face was enrolled. Nothing else in this design would notice either: because unlock deliberately involves no issuer round trip, there is no server-side event, no audit trail of the access, and no way for the patient or the covered entity ever to discover it.

So someone who covertly or coercively adds their own biometric to the patient's device — an abusive partner, a family member, a border or custody enrolment — obtained permanent, silent, indefinite access to the entire local diary and to a live bearer credential. Under an issuer-round-trip design the same attacker would at least be bounded by refresh-token lifetime and would appear in issuer logs.

`expo-secure-store` supplies exactly the missing signal. `requireAuthentication: true` maps to iOS `biometryCurrentSet` and Android `setUserAuthenticationRequired(true)`, and the module documents the effect: *"Keys are invalidated by the system when biometrics change, such as adding a new fingerprint or changing the face profile used for face recognition. After a key has been invalidated, it becomes impossible to read its value."* This is an OS guarantee the app cannot reimplement.

## Decision

> **Superseded in part by Amendment 2 (2026-10-07).** The passcode is now a peer of the
> biometric and the refresh token is stored **without** `requireAuthentication`. Read this
> section for the threat model and the reasoning, which still stand; read Amendment 2 for
> what is actually built.

We will keep biometric unlock as the sole gate on local data, with no issuer round trip — and we will set `requireAuthentication: true` on the stored refresh token so that a biometric enrolment change invalidates it and forces a full OIDC re-login.

We will also request Android Class 3 biometrics explicitly (`biometricsSecurityLevel: 'strong'`), and store the refresh token under `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.

The SQLCipher database key deliberately does **not** take `requireAuthentication` — see ADR-0014.

## Consequences

**What this gets us.** Unlock stays fully offline, so the core use case is untouched. A covert enrolment now costs the attacker the stored credential rather than granting indefinite access, and the resulting re-login does reach the issuer and does leave a record. Class 3 excludes Android Class 2 face unlock, which on many implementations is defeatable with a photograph and would otherwise be all that stands between a stranger and the patient's clinical history. `_THIS_DEVICE_ONLY` stops the refresh token riding an encrypted backup onto a second phone, where it would be a live bearer credential for the patient's account.

**What this costs.** The OS presents its own prompt on reading the token, so the app no longer fully controls that copy — which is precisely the concern the original implementation was protecting, and it is a real regression in polish. On iOS there is no prompt on *create*, only on read, so the interaction is asymmetric. A patient who legitimately adds a fingerprint is signed out and must complete a full OIDC login, which needs network; if they are offline at that moment they cannot get in at all. Class 3 also excludes some working Class 2 sensors on older Android hardware, pushing those users to the device passcode fallback.

**What it forecloses.** Nothing structural. Both flags can be relaxed later without a data migration, unlike ADR-0014's encryption decision.

**Verification gap, stated plainly.** None of this is exercised by the test suite: jest does not run a keychain, and enrolment invalidation cannot be simulated. The Class 3 option is asserted at the call site, but the invalidation behaviour, the iOS create/read prompt asymmetry, and the passcode fallback all need testing on real iOS and Android hardware before release. This ADR records the decision; it does not record a verified implementation.

**Residual risk accepted.** Biometric unlock still grants access to the local diary without contacting the issuer, so a coerced *live* unlock — someone compelling the patient to present a finger or face — reads everything. No client-side control addresses that, and the offline requirement rules out the one that would.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Require an issuer round trip on unlock | Breaks the core use case. The app is used in public restrooms and while travelling; an unlock that needs connectivity loses the entry it exists to capture. |
| Detect enrolment changes at the app layer | Not possible. `expo-local-authentication` reports current state only and exposes no change signal, and there is no equivalent of iOS's `evaluatedPolicyDomainState`. |
| Set `requireAuthentication` on the SQLCipher key as well | An invalidated database key costs the patient every unsynced entry permanently, with no recovery path. An invalidated refresh token costs a re-login. The asymmetry is deliberate (ADR-0014). |
| `disableDeviceFallback: true`, so only biometrics unlock | Excludes patients whose biometrics fail to enrol or read — post-surgical hands, dry skin, tremor — from their own diary. This population skews older and post-surgical, so the fallback matters more here than it would elsewhere. |
| Accept the original design and record the risk only | The exposure is silent and indefinite, with no audit trail by construction, and the fix is one option flag that preserves the offline property in full. |


## Amendment 1 (2026-09-25): a device with no biometric enrolled

Issue #74. The decision above is unchanged for any device that can honour it. This amendment covers the case it did not consider: a device with **no Class 3 biometric enrolled at all**.

### What went wrong

`requireAuthentication: true` cannot be *written* on such a device. The flag makes `expo-secure-store` create a keystore key specifying `AUTH_BIOMETRIC_STRONG`, and with nothing enrolled to satisfy it the write is rejected outright:

```
'ExpoSecureStore.setValueWithKeyAsync' has been rejected.
→ Caused by: Could not Authenticate the user: No biometrics are currently enrolled
```

That rejection surfaced from `AuthContext`'s `completeLogin` **after** a successful authorization code exchange, so the failure was not "the session is less protected" — it was "the patient cannot sign in", online or off. They were shown "We could not sign you in. Please try again.", advice that cannot work however many times it is followed.

Two things about how this was missed are worth recording. It is invisible to the test suite for the reason this ADR already states: jest runs no keychain. And it was invisible on the emulator used for Gate B, because that device had a fingerprint enrolled — enrolling one is what localised the bug, which means the *absence* of an enrolment is a device state that has to be tested deliberately rather than encountered.

A second defect had the same root and a wider reach. `isBiometricUnlockAvailable()` asked `isEnrolledAsync()`, which on Android answers for biometrics only. A patient with a device PIN and no fingerprint got `false`, and `app/login.tsx` then offered them nothing but "Sign in again instead" — a network OIDC login. So even with a token successfully stored, an unenrolled patient had **no offline route into their own diary**, on the one client that exists to work offline. Nothing else in the design agreed with that check: `authenticate()` passes `disableDeviceFallback: false` deliberately, and `login.unlockHint` promises "Use your face, fingerprint, or phone passcode" in so many words.

### Decision

1. **The gate is applied wherever the OS will accept it**, decided from `getEnrolledLevelAsync()` rather than by attempting the write and catching its failure. A catch would also swallow a gated write that failed for some other reason on a device where gating *is* possible, silently storing a credential with less protection than the device can provide. On such a device the failure still propagates, exactly as before.

   **A live level read is not proof the device cannot gate**, which is the other half of the same argument and was missed on the first pass. `getEnrolledLevelAsync()` reports `BIOMETRIC_STRONG` only while `canAuthenticate(BIOMETRIC_STRONG)` answers `SUCCESS`, so a sensor locked out after failed presses, `BIOMETRIC_ERROR_HW_UNAVAILABLE`, or the documented post-OTA `BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED` all read as `SECRET` on a phone with a fingerprint enrolled. Deciding from that read alone both downgraded a gatable token *and* recorded a `SECRET` baseline, so the next cold start saw a rise and purged — signing the patient out, and telling them their unlock settings changed, for something that never happened. So **an existing gated marker is standing evidence that this device supports gating**: keep gating and let a rejection propagate. A device that has genuinely lost its biometric never reaches that point with a gated marker, because the token is purged first.

2. **Where the OS refuses it, the token is stored without the gate** rather than not stored at all. `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` is unaffected and still applies: nothing about enrolment bears on whether the entry may ride a backup onto another phone.

3. **The lost invalidation signal is reimplemented for exactly that case.** The stored marker records the enrolment level the token was written at, and a level *rise* purges it and forces a full OIDC re-login. This ADR says an app cannot detect an enrolment change, and that remains true where a biometric already exists — `getEnrolledLevelAsync()` reports the same level before and after a second fingerprint is added. But a token stored ungated on a device at `NONE` or `SECRET` was stored with **none** enrolled, so a first enrolment raises the level. That transition is observable, and it is precisely the covert-enrolment threat this ADR exists to close. The purge also upgrades the protection where it can: the token written by the forced re-login is gated, if the new level permits it.

   **This does not cover every ungated token, and the first version of this amendment claimed it did.** A `BIOMETRIC_WEAK` device also takes the ungated path, because a Class 2 sensor cannot back an `AUTH_BIOMETRIC_STRONG` key — and there the level reads `BIOMETRIC_WEAK` before and after a second face is enrolled, so that covert enrolment is not detected. The exposure is narrow, since enrolling requires the device credential, which already satisfies this app's own prompt. It is recorded here rather than left for someone to rediscover from the code.

   **A gated token whose key the OS has already invalidated is a separate case and is deliberately not decided from the level.** The obvious rule — gated, and the level fell — would purge a good session during any sensor lockout, for the reason in point 1. It is detected instead by `unlock()` reading the token and getting nothing, which is ground truth rather than inference. That read happens only when discovery is available, so it cannot fire for an offline patient who does not need the token yet.

4. **Local unlock accepts the device passcode**, which is what `disableDeviceFallback: false` always intended. The availability check now asks `getEnrolledLevelAsync() !== NONE`, and is renamed `isLocalUnlockAvailable` — the old name is what made the mistake easy to write and easy to miss.

   It asks **only** that. The first version of this amendment also gated it on `hasHardwareAsync()`, which reports whether a face or fingerprint *scanner* exists — and `getEnrolledLevelAsync()` answers `SECRET` from the screen lock alone, on a handset with no sensor at all. That short-circuit reproduced the defect above for every sensorless phone, which is a real and cheap-Android-common configuration. It was the same conflation of "has biometrics" with "can be authenticated" that this point exists to undo, one layer further down, and both reviews caught it independently.

### Why this rather than the alternatives

| Option | Why not |
|---|---|
| Require biometric enrolment to use the app, and say so before sign-in | Excludes patients whose biometrics fail to enrol — post-surgical hands, dry skin, tremor. This ADR's own alternatives table rejected `disableDeviceFallback: true` for that exact population, so shipping the same exclusion through a different mechanism would contradict a decision already made here. |
| Do not persist a refresh token at all without enrolment | Preserves this ADR's guarantee untouched and is the most conservative option. Rejected because it makes every cold start require network for that patient, which removes offline-first from the only offline client — the property the Context section above calls the core use case. |
| Keep failing the sign-in and treat it as a supported configuration | It is a total lockout presented as a transient error, and the remedy shown to the patient cannot work. |

### Consequences

**What this costs, stated plainly.** A patient with no biometric enrolled holds a refresh token protected by device encryption and `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, but not by a keystore key the OS will invalidate. Their diary is reachable with the device passcode. That is a weaker posture than an enrolled patient's, and it is the posture the alternatives above were weighed against rather than one chosen for convenience.

**What it does not catch.** A passcode changed while remaining a passcode (`SECRET` to `SECRET`) is not a level rise and is not detected. Neither is a second Class 2 biometric on a `BIOMETRIC_WEAK` device, per point 3. Neither is tampering with the marker, which is ungated by necessity — it has to be readable without a prompt, since being readable without a prompt is the entire reason it exists. The last two require the attacker to hold an unlocked device, at which point they can read the diary regardless.

**The two mechanisms differ in timing, and that is not a detail.** The gated case has no window at all: the OS invalidates the key the moment the enrolment lands. The reimplemented one is checked at two moments — cold start and unlock — so an enrolment made while the app process is alive is not noticed until one of them. An Android process can live for days, so the unlock check is load-bearing rather than belt-and-braces: without it, someone who enrols their own biometric while the app is running could open it at the lock screen, satisfy the OS prompt with the print they just added, and be handed a live bearer credential with nothing recorded anywhere.

**One false positive remains, in one place.** A momentary `canAuthenticate` failure lowers the reported level, and a lower level cannot look like a rise — so the rule is safe against it everywhere except a first-ever sign-in that happens during such a moment on a phone that does have a strong biometric. The token is stored ungated with a low baseline, and the next launch reads a rise. The cost is one spurious re-login, which needs a network, after which the token is gated correctly.

**It can also sign a patient out at a bad moment.** The purge lands them on a full OIDC login, which needs connectivity; a patient who enrols a fingerprint and next opens the app offline cannot complete it, and their diary is on the device the whole time. This ADR already accepted that cost where the OS forced it, but here the app chooses it, so it is worth stating: the choice is between that and leaving a credential readable by whoever added the biometric. The mitigation is copy, not timing — `login.unlockChangedHeading`/`Body` say what happened and that nothing they wrote is lost, and the reason is persisted rather than held in memory precisely because the patient will close the app and come back.

**Verification gap, unchanged and now larger.** Everything above needs a device. Nothing in jest can create the state that produced #74, and the emulator used for Gate B could not either, because it had an enrolment. `docs/gate-b-hardware-verification.md` carries the walkthrough as **HW-11**; until it is run, treat this amendment as a decision with a tested implementation of its *logic* and no verification of its behaviour on hardware.

## Amendment 2 (2026-10-07): the device passcode is a peer, not a fallback

Issue #116. This amendment **changes** the decision above rather than extending it, and the title of this ADR changes with it: biometric is no longer the gate, it is one of two accepted gates.

### What went wrong

#117 found that the app was asking the OS to refuse the passcode outright — `disableDeviceFallback` reached the native layer as `true` despite being documented, and declared in Expo's own Kotlin record, as defaulting to `false`. Measured at the OS boundary: `authenticators: 15` (`BIOMETRIC_STRONG` alone) with the option omitted, `32783` (`| DEVICE_CREDENTIAL`) with it passed. That is fixed.

Fixing it was not enough, and the reason is this ADR's own decision. `requireAuthentication: true` makes `expo-secure-store` raise its **own** prompt when the refresh token is read, and that prompt is built with a negative button and no allowed authenticators — a combination Android forbids pairing with `DEVICE_CREDENTIAL`. It is **biometric-only by construction, at any setting**. Observed as a second dialog at `authenticators: 15` immediately after the app's own prompt succeeded at `32783`:

```
showAuthenticationDialog, authenticators: 32783, credentialAllowed: true   <- the app's gate
unlockUser finished                                                        <- passcode accepted
pendingCallback: 7                                                         <- DISMISSED_CREDENTIAL_AUTHENTICATED
showAuthenticationDialog, authenticators: 15, credentialAllowed: false     <- SecureStore's gate
```

So a patient cleared the gate this app controls, using the passcode this ADR deliberately preserved, and was stopped by a gate it does not control. `unlock()` read that failure as `unreadable` and re-locked, which presents as the unlock button silently doing nothing, and pressing it again doing nothing.

**This ADR had already rejected that exclusion twice.** The alternatives table above rejects `disableDeviceFallback: true` because it "excludes patients whose biometrics fail to enrol or read — post-surgical hands, dry skin, tremor". Amendment 1 rejects requiring enrolment because "shipping the same exclusion through a different mechanism would contradict a decision already made here". The gated read was a third mechanism delivering the same exclusion, and it had shipped.

### Decision

**Unlocking the diary accepts either the device credential or a Class 3 biometric, as equal peers.** Neither is primary and neither is a fallback from the other.

1. A patient who prefers not to use biometrics uses their passcode and never enrols. A patient whose finger is wet or bandaged, or whose sensor has locked out, uses their passcode for that attempt and their biometric the next. Both are ordinary supported paths rather than degraded ones.
2. **The refresh token is stored without `requireAuthentication`**, on every device, because that flag is what makes the passcode impossible one layer down. `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` is unaffected and still applies.
3. **Amendment 1's enrolment-level rise purge is removed** — see below for why it stops being a security control under this decision rather than merely becoming inconvenient.
4. ADR-0014 is unchanged, and is now *consistent* with this one: the SQLCipher key was always ungated, so the diary already opened without a biometric. Only the credential was gated.

### Why the invalidation guarantee stops being worth its cost

The Decision section above bought one thing with `requireAuthentication`: the OS invalidates the key when biometric enrolment changes, so a covert or coerced enrolment — "an abusive partner, a family member, a border or custody enrolment" — costs the attacker the stored credential instead of granting indefinite silent access.

That guarantee defended against a **privilege escalation**. It was worth paying for precisely because biometric was the only authenticator the gate accepted, so adding one granted an authenticator the attacker did not previously have.

Once the passcode is a peer, the escalation disappears: **enrolling a biometric on Android requires the device credential already**. Amendment 1 says this in as many words — "the exposure is narrow, since enrolling requires the device credential, which already satisfies this app's own prompt" — and used it to accept the same exposure on `BIOMETRIC_WEAK` devices. An attacker who can enrol can already unlock. The invalidation now fires on a transition that grants nothing, and its only reliable effect is to sign out a legitimate patient who added a fingerprint, pushing them into an OIDC login that needs network they may not have.

The same argument retires Amendment 1's level-rise purge. It exists to reimplement the invalidation signal where the OS could not provide it, and it detects exactly one transition — `NONE`/`SECRET` to enrolled. Under this decision that transition is not an escalation either, so the purge signs patients out for no gain.

### What this gives up, stated plainly

**An attacker who knows the device passcode and has no enrolled biometric now obtains the refresh token.** Before this amendment they could not: the gate was biometric-only, and enrolling one to get past it would have invalidated the key. That is a real reduction in protection and it is accepted rather than argued away.

What bounds it:

- They could already read **the entire local diary**, because ADR-0014 leaves the SQLCipher key ungated and this app's own gate has accepted the passcode since #117. The new exposure is the account credential, not the clinical history.
- `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` still stops the token riding a backup onto a second phone, so the exposure requires the physical device.
- ADR-0014's subject binding still destroys the local store when a different OIDC subject signs in.
- The device passcode was already the trust boundary for PHI at rest on this client. This puts the credential at the same boundary as the data it protects rather than one notch above it.

**The residual risk in the Decision section is unchanged and now reads more simply:** local unlock grants the diary without contacting the issuer, so anyone who can unlock the device can read it. No client-side control addresses that, and the offline requirement rules out the one that would.

### Alternatives considered

| Alternative | Why not |
|---|---|
| Keep `requireAuthentication` and tell the patient to sign in again when the biometric fails | Makes the offline client require network at exactly the moment it is used offline — a public restroom, travelling. That is the failure this app exists to avoid, imposed on the population this ADR twice refused to exclude. |
| Keep `requireAuthentication` and admit the patient to the diary without reading the token | Preserves invalidation and fixes the lockout, and was the leading candidate before this decision. Rejected because it rests on a fact the code itself flags as unverified — whether an invalidated key surfaces as `null` or as a throw. If it throws, the attacker lands in the same branch as the wet finger and is admitted. The distinction is testable, but the design would be one device-behaviour discovery away from being wrong. |
| A custom keystore key with `AUTH_BIOMETRIC_STRONG or AUTH_DEVICE_CREDENTIAL` | Including `AUTH_DEVICE_CREDENTIAL` means the key is **not** invalidated by biometric enrolment, so it buys the passcode peer and loses the guarantee anyway — the same trade as this decision, reached through a native module replacing `expo-secure-store` on the security-critical path in a managed workflow, with its own hardware-verification burden. |
| Require a biometric and offer no passcode | Already rejected twice above. Recorded again only because this amendment is where someone will look for it. |

### Consequences

**Simpler, and that is a security property too.** The gated/ungated branch in `tokenStorage.ts`, the stored enrolment level, the rise detection and the purge all exist to manage a guarantee this decision retires. Amendment 1 records four distinct defects found in that machinery across two reviews — a live level read mistaken for proof, a `hasHardwareAsync` short-circuit that locked out sensorless phones, a false-positive purge on sensor lockout, and a gap on `BIOMETRIC_WEAK` devices. Removing it removes that surface.

**One forced re-login on upgrade.** An entry written with `requireAuthentication` cannot be read without it, so an install holding a gated token must purge it and sign in once. v1 has not shipped and there is no production (CLAUDE.md), so this costs development installs a sign-in and nothing else. It is named because it would be a migration if discovered later rather than decided now.

**What is NOT decided here: a persisted "passcode only" preference.** The OS prompt shows the biometric affordance first with the passcode one tap away, so a patient who never enrols sees only the passcode, and a patient who has enrolled chooses per unlock. That delivers the capability in this amendment's first clause. What it does not deliver is a patient with an enrolled biometric telling the app to stop offering it — `expo-local-authentication` exposes no credential-only mode, so that needs a preference and a different call. It belongs with the rest of SRS §3.10 preferences at **P4.S3**, and is deliberately not invented here.

**Verification gap, unchanged in kind.** Everything above still needs a device. What changes is which steps: HW-6 tested a guarantee that no longer exists, and HW-11's purge half goes with it. `docs/gate-b-hardware-verification.md` is updated in the same change rather than left describing the old rule.
