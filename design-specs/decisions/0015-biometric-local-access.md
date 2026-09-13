# ADR-0015: Biometric alone unlocks local data, but an enrolment change invalidates the token

- **Status:** Accepted
- **Date:** 2026-09-12
- **Deciders:** Steven Waldren
- **Related:** SRS_v2 §4.2, §5.2 | [ADR-0014](0014-local-phi-encryption-and-device-ownership.md) | PR #15

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
