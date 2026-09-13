# Breach notification procedure

- **Owner:** [Security & Privacy Officer — TBD]
- **Last reviewed:** [ ]
- **Next review:** [ ]
- **Governing rule:** FTC Health Breach Notification Rule, 16 CFR Part 318

> This is a working procedure, not legal advice. The clocks and recipients below are the ones the rule sets; confirm them with counsel before the first notice is ever sent, because a notice sent late is not curable.

## Which rule applies, and why

This product is **direct-to-patient**. Patients sign up themselves; the app is not offered by or on behalf of a healthcare provider, so this is neither a HIPAA covered entity nor a business associate, and HIPAA's breach rule does not apply. It is a vendor of personal health records holding identifiable health information, which places it under the **FTC Health Breach Notification Rule**.

We build to HIPAA's technical safeguards anyway — encryption, audit logging, access control, session timeouts — as a voluntary standard (see `docs/security-hipaa.md`). That is a deliberate choice and it does not change which breach rule governs.

**This changes the moment a clinic or provider offers the app to their patients.** SRS_v2 §3.5 Epic 5's secure share link is the feature most likely to create that relationship. At that point we become a Business Associate, HIPAA applies for real, a BAA is required with each provider, and the clocks below are replaced by HHS's. Re-read this document then; do not assume it still applies.

## What counts as a breach

Acquisition of identifiable health information **without the authorization of the individual**. Unlike HIPAA, the FTC rule has no "low probability of compromise" exception to reason your way out of — an unauthorized acquisition is a breach.

Two consequences worth internalising:

- **Encryption is the practical safe harbour.** Data that cannot be read has not been acquired in any meaningful sense. This is why ADR-0014 encrypts the on-device store: an encrypted lost phone is an incident, and an unencrypted one is a notification event.
- **A disclosure we caused ourselves counts.** Sharing data in a way the patient did not authorize is a breach under this rule even with no attacker involved.

## Discovery

A breach is **discovered** on the first day any person associated with the product knows of it, or would have known by exercising reasonable diligence. The clock starts on discovery, not on confirmation, not on completing the investigation.

Record the discovery timestamp immediately and in writing, before doing anything else. Every deadline below counts from it.

## The clocks

| Who | When |
|---|---|
| **Affected individuals** | Without unreasonable delay, and **no later than 60 calendar days** after discovery |
| **The FTC** | If **500 or more** individuals: **no later than 60 calendar days** after discovery. Fewer than 500: log it and file annually, within 60 days of the calendar year's end |
| **Media** | If **500 or more residents of one state or territory**: prominent media notice there, on the same 60-day clock |
| **Third-party service providers** | If a provider to *us* discovers a breach, they must notify us; if we act as a provider to another service, we must notify them |

"Without unreasonable delay" is the operative standard. Sixty days is a ceiling, not a target, and taking all of it without cause is itself a finding.

## What the notice must say

Written in plain language, at the reading level the rest of the product targets:

1. What happened, and the date of the breach and of its discovery.
2. What information was involved — name the categories, specifically. For this product that means stoma output volumes, weights, timestamps, and any account identifiers.
3. What the individual can do to protect themselves.
4. What we are doing to investigate, mitigate, and prevent recurrence.
5. How to reach us: a phone number, an email address, a website, or a postal address.

Notice goes by first-class mail, or by email where the individual has consented to electronic notice. If contact information for ten or more people is out of date, substitute notice is required.

## Device loss — the runbook for the most likely first incident

A lost or stolen patient phone is the incident this product is most likely to have, and the controls already in place determine the answer.

1. **Establish whether the local store was encrypted.** ADR-0014 encrypts it with SQLCipher, keyed from `expo-secure-store` and bound to the device. Confirm the build the patient was running actually had it — an older build predating that ADR did not.
2. **Establish whether the key could travel with the file.** The key is stored `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`, which the keychain does not migrate on backup restore. A backup restored onto another device yields an undecryptable file.
3. **Check the iOS backup gap.** Backup exclusion is *not* implemented on iOS (`expo-file-system@57` removed the API), so the encrypted file does enter iCloud. That is ciphertext without a migrating key, but it is a fact the assessment must state rather than omit.
4. **Revoke.** Revoke the refresh token at the issuer. Note that biometric enrolment change already invalidates it (ADR-0015), and that a *live* coerced unlock is not addressed by any control.
5. **Assess and record.** Encrypted, key non-migrating, no evidence of decryption → document the reasoning and why no notice is required. Anything else → assume acquisition and start the 60-day clock.

## Roles

| Role | Responsibility |
|---|---|
| [Security & Privacy Officer — TBD] | Declares a breach, owns the clock, signs the notice |
| Engineering | Preserves evidence, reconstructs scope from `audit_events` (indexed by `correlation_id` precisely because this query runs under a notification clock), implements mitigation |
| Counsel | Reviews the notice before it is sent; confirms whether the FTC or HHS rule applies if the relationship model has changed |

## Preserve the evidence

**Do not purge anything relevant to an open investigation**, including through the ADR-0017 deletion job. That job is the one path that can remove audit rows; a deletion request arriving mid-investigation must be held, and the hold recorded, until scope is established. Record the hold and its lifting in the `deletion_log`.

## Open items

- [ ] Named Security & Privacy Officer
- [ ] Counsel review of this procedure
- [ ] Contact channel for notices (address, phone, email) established before launch
- [ ] Confirm with counsel whether any state breach law also applies to the resident population served
