# ADR-0020: Ship v1's mobile client on Android only

- **Status:** Accepted
- **Date:** 2026-09-19
- **Deciders:** Steven Waldren
- **Related:** SRS_v2 §2, §4.2 | [ADR-0014](0014-local-phi-encryption-and-device-ownership.md) | [ADR-0015](0015-biometric-local-access.md) | `docs/gate-b-hardware-verification.md` | sprint R.S2 in `design-specs/planning/v1-implementation-plan.md`

## Context

SRS §2 requires "a native/hybrid mobile application (iOS and Android)", §4.2 names "iOS + Android", and `app.json` declares both platforms. **`apps/mobile` has never been built for iOS.** There is no `eas.json`, no macOS in the development loop, and no record of an iOS build anywhere in this repository's history.

Expo's managed workflow makes that easy to overlook, because it makes an iOS build *plausible* without making it real. What has never compiled, let alone run, is precisely the part that is not portable:

- the `expo-sqlite` config plugin that turns on SQLCipher (ADR-0014) — a native change, which is why this app cannot run in Expo Go at all;
- `NSFaceIDUsageDescription` and the `expo-local-authentication` Face ID permission;
- the keychain accessibility class `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, whose non-migration on backup restore is the entire reason ADR-0014 tolerates the file entering iCloud;
- `requireAuthentication` mapping to iOS `biometryCurrentSet`, which is the OS guarantee ADR-0015 is built on and cannot reimplement.

Every item in that list is a security control whose failure mode is a PHI disclosure, not a broken screen.

**This surfaced from writing down the verification steps, not from hitting it in code.** `docs/gate-b-hardware-verification.md` enumerates what would discharge CLAUDE.md's "none of the mobile device-side controls are verified on hardware" caveat, and five of its ten steps — HW-4, HW-5, HW-6b, HW-9, HW-10 — turned out to be blocked not on scheduling but on a build path nobody was building. The steps could not be run, and no sprint was going to make them runnable, because establishing an iOS build path had never been anyone's work.

What establishing it costs is not trivial and is not one sprint: a macOS machine with Xcode or an EAS Build account, an Apple Developer membership, a signing identity, and a first build that surfaces every native problem in an app this size at once — all before a single iOS patient exists.

**iOS users are not shut out of the product.** `apps/web` is a standard browser SPA and runs on iOS Safari today. It is online-only by explicit architectural decision (SRS §4.2) and holds no PHI at rest, so what an iPhone user loses is offline capture, not access.

## Decision

We will ship v1's mobile client on **Android only**, and state that in the spec rather than carrying a platform claim nothing verifies.

Specifically:

- `app.json` declares `platforms: ["android"]`.
- The `ios` script is removed from `apps/mobile/package.json`. Nothing in this repository builds or starts an iOS target.
- SRS_v2 is amended to v2.6 at §2 (Cross-Platform Availability) and §4.2 (Mobile app).
- `docs/gate-b-hardware-verification.md` is rescoped: HW-4, HW-5 and HW-9 are marked out of v1 scope, HW-6 reduces to its Android half, and HW-10 becomes an Android background-termination step. The IDs are **kept stable** — issue #39 and the plan both cite them.
- **The iOS configuration in `app.json` stays** — `bundleIdentifier`, `NSFaceIDUsageDescription`, the Face ID permission. It is inert while `platforms` excludes iOS, and it is the record of what iOS needs. Reinstating the platform should be a scope decision, not an archaeology exercise.

**This closes ADR-0014's known gap by scope rather than by a plugin.** That ADR recorded iOS backup exclusion as unimplemented because `expo-file-system@57` removed `setIsExcludedFromBackupAsync`. There is now no iOS build for the database to leave, so there is no iCloud egress path to mitigate. ADR-0014 is not edited — it is immutable and its reasoning stands for the platform it was written about; this ADR narrows its scope the way ADR-0012 completed ADR-0005.

## Consequences

**What this gets us.** Every platform this repository claims is now one it can test. The hardware verification list becomes runnable on a handset we can actually obtain, which unblocks #39 and with it #40 — the predicted defect in the biometric invalidation path has a step that settles it. ADR-0014's open gap closes without writing a config plugin for a platform we do not ship, and the two compliance documents that carry that gap as a live risk (`risk-analysis.md` row 2, `breach-notification.md` step 3) stop describing an exposure the product no longer has. The release lane is one store, one signing identity, one review process.

**What this costs, and it is the real price.** iPhone patients get no offline capture. That is the single most valuable property of this product, and the use case driving it — logging in a public restroom, logging while travelling — is not Android-specific. In the US market this is roughly half the addressable population reduced to a browser SPA that cannot capture an entry without connectivity. The cut is accepted because a half-tested security control is worse than an absent platform, **not** because the loss is small, and it should be revisited on that basis rather than treated as settled forever.

A second cost is quieter: ADR-0015's iOS-specific reasoning — the create/read prompt asymmetry, `biometryCurrentSet`, the absence of an `evaluatedPolicyDomainState` equivalent — stays unexercised, so the knowledge of it decays while the code that depends on it remains in the tree.

**What it forecloses.** Nothing structurally. Expo keeps the door open and the iOS configuration stays in the repo. What becomes expensive is reinstating iOS *late*: every sprint of mobile code written between now and then is written against a platform nothing compiles, and the first iOS build of a much larger app surfaces all of it at once — which is the situation this ADR exists to stop compounding. So reinstatement belongs at a phase boundary with its own verification pass, never as a flag flip in `app.json`.

We would find out this was wrong the first time a clinician or a patient asks for the iPhone app, which is a question this product should expect rather than be surprised by.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Establish the iOS build path now | A macOS machine or EAS plus an Apple Developer membership, a signing identity, and a first build that surfaces every native problem at once — all before one iOS patient exists. The plan defers this rather than dropping it; the door stays open. |
| Keep iOS in scope and leave it unbuilt | The status quo, and the worst of the options. The spec claims a platform, `app.json` builds for it, and nothing verifies the security controls that platform would run. A claim nothing tests is the exact failure mode ADR-0014 and ADR-0015 exist to prevent. |
| Ship iOS unverified | The unverified code is SQLCipher key handling, keychain accessibility and biometric invalidation. A defect in any of them is a PHI disclosure on a device outside the covered entity's control, discovered by a patient rather than by us. |
| Make `apps/web` the offline client for iOS instead | `apps/web` is online-only by explicit architectural decision (SRS §4.2, CLAUDE.md). Reversing that means a second offline store, a second sync implementation, and a second place PHI rests — to serve a platform we are cutting precisely to avoid unverified PHI-bearing code. |
| Cut mobile entirely and ship web-only | Offline capture is the product's core clinical value (SRS §4.2, §4.5). Removing it is a different product, not a scope cut. |

## Spec impact

**Spec update required.** SRS_v2 → **v2.6**:

- **§2 Cross-Platform Availability** — "iOS and Android" becomes Android, with the browser SPA named as the iOS route and the deferral marked as a v1 scope decision recorded here.
- **§4.2 Mobile app** — "Expo/React Native, iOS + Android" becomes Android.

`CLAUDE.md` is updated in the same change: the `apps/mobile` paragraph's iOS-backup sentence, and the architecture section's mobile line. `docs/architecture.md`, `docs/getting-started.md`, `docs/security-hipaa.md`, `docs/compliance/risk-analysis.md`, `docs/compliance/breach-notification.md` and `apps/mobile/README.md` are corrected alongside, because each states the iOS claim or the iOS gap independently.

The v1 scope statement in SRS Appendix A is untouched: this is a platform deferral, not a feature deferral, and it does not belong with urostomy.

## Compliance and safety review

**Yes — this touches PHI handling**, and the change is a net reduction in exposure rather than a mitigation.

- **iCloud egress (ADR-0014's known gap, `risk-analysis.md` risk 2)** — closed by removal of the platform. Both compliance documents are updated to say so rather than continuing to describe a live gap.
- **No control is weakened.** SQLCipher, subject binding, purge-on-signout, session re-lock, `requireAuthentication` and Class 3 biometrics all remain exactly as ADR-0014 and ADR-0015 specify, on the platform that now ships.
- **The verification gap narrows but does not close.** Android's device-side controls remain unverified on hardware; that is #39, and `docs/gate-b-hardware-verification.md` still records none of them as run. Nothing in this ADR licenses describing them as verified.

Per the plan, `hipaa-compliance-reviewer` review of R.S2 is **blocking**.

## Notes

- **Revisit at a phase boundary**, with an iOS verification pass of its own — HW-4, HW-5, HW-6b, HW-9 and HW-10 are retained in the hardware document, marked out of scope rather than deleted, so reinstatement starts from the list rather than from memory.
- The decision this ADR does **not** make: whether the eventual iOS path is EAS Build or a macOS machine with Xcode. That is an engineering choice for the sprint that reinstates the platform, and making it now would be deciding it with no build to learn from.
- A scope cut that lives only in a planning document removes the pressure to verify without removing the claim. That is risk R10 in the implementation plan, and this ADR plus the edits it names are what answer it.
