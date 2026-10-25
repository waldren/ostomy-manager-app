# Real-data readiness

- **Owner:** [Security & Privacy Officer — TBD]
- **Decided by:** [ADR-0022](../../design-specs/decisions/0022-self-hosted-production-on-one-host.md)
- **Status:** **not ready.** No item is signed off.

These are the things that must be true before any server is initialised to hold a real patient's data.

**The deploy CLI reads this file.** `init --classification real` refuses unless every row in the table below has a sign-off (D.S1 slice 3). This list is a gate the tooling enforces, not one someone has to remember. The plan's R9 explains why that matters: a prose document has no failing test.

## How a row is signed off

- **The "Signed off" cell** holds `Name, YYYY-MM-DD` and nothing else. A row whose cell is `—`, empty, or in any other shape counts as **unsigned**.
- **The sign-off rule.** The person signing confirms the evidence exists, and links it in the Evidence column. The signer must not be the person who did the work, wherever the project has a second person. Where it does not, say so in the Evidence column rather than leaving it implied.
- **IDs are permanent.** They are never renumbered or reused, because issues, the ADR and the CLI's refusal message cite them.
- **Adding a row.** A new row arrives unsigned, so it re-closes the gate for any host not yet initialised. That is intended.
- **Removing a row.** This needs an ADR, or an amendment to ADR-0022, saying why the risk no longer applies. Do not delete one because it is inconvenient.

## Readiness items

| ID | Item | Evidence required | Signed off |
|---|---|---|---|
| RD-1 | **The clinical numbers are ratified by a clinician.** This covers every implementer-chosen value a patient is shown as guidance: the suggested-range defaults (`clinical_default_ranges`), the validation thresholds including the stoma-output warning (#93), and the 120 bpm heart-rate red flag. | #144 closed, with the clinician named and each value either ratified or changed by migration or `admin-config` | — |
| RD-2 | **The device-side controls pass on real hardware.** HW-1, 2, 3, 6, 7, 8, 10, 11 and 12 must each pass on a physical Android phone, running a release build against a **synthetic** self-hosted server over HTTPS. | Each step's row in `docs/gate-b-hardware-verification.md`'s results table filled in; #39 closed | — |
| RD-3 | **Account deletion works end to end.** Access is revoked at once, and the hard purge, including the patient's audit rows and profile audit rows, completes within 30 days (ADR-0017). | P5.S7 merged; #143 closed; a purge run on a synthetic host recorded | — |
| RD-4 | **An operator environment is named, and the development host has never had access to it.** It is the only place holding the real host's SSH key, the real release keystore and the backup decryption key (ADR-0022 §2). | What it is and where it is, written in the Evidence column; how its own disk is protected | — |
| RD-5 | **A Security & Privacy Officer is designated.** The breach procedure needs someone to start its clock. | `security-officer.md`'s designation table filled in | — |
| RD-6 | **The hosting provider is chosen and recorded.** It must encrypt volumes at rest. Its jurisdiction must be known. Its terms must say how and when it notifies us of a breach (16 CFR 318.4). | The provider is named in `docs/security-hipaa.md`'s service list, with the three facts and links to the terms | — |
| RD-7 | **A restore from the off-host backup is carried out and timed.** It must be done on a fresh synthetic host. The data restored must be no older than SRS §5.3's 24-hour RPO, and service must be back within its 4-hour RTO. | The runbook's restore record: date, backup age, elapsed time | — |
| RD-8 | **A penetration test is complete, against a synthetic host of the real shape.** Every finding is fixed or explicitly accepted. | `penetration-testing.md` updated with the report reference and the disposition of each finding | — |
| RD-9 | **Patients are told what is collected, where it is held, and how deletion works.** This is a privacy notice that matches ADR-0017 and this host, and patients must agree to it before their first entry. | The notice's location, and the commit that shows it before first use | — |
| RD-10 | **A usability and accessibility review has been held with representative patients** (SRS §5.4, pre-launch). | A written summary, and the disposition of each finding | — |
| RD-11 | **Admin MFA is enforced and verified.** An `admin` realm account without OTP cannot obtain a token. | A recorded attempt on a synthetic host, refused; #89 closed or updated | — |
| RD-12 | **The known defects that harm a real patient's entries are fixed, or accepted in writing.** This means at least #151 (a lost entry), #159 (correct entries quarantined) and #164 (a delayed save confirmation), plus any newer open issue labelled `bug`. | Each issue is closed, or carries a written acceptance from the signer | — |
| RD-13 | **The release build is the shape ADR-0022 requires.** It is signed with the operator keystore, has cleartext traffic off, refuses performance marks (#163), and has `minSdkVersion` 29. | D.S1 slice 4 merged, and #163 closed | — |
| RD-14 | **Secret rotation and incident steps are written for this host.** The runbook covers rotating every generated secret, revoking a lost operator key, and the first hour of a suspected breach, linked to `breach-notification.md`. | The runbook sections (D.S1 slice 5) | — |

## What this list deliberately does not contain

- **Engineering completeness.** Missing features (P5–P8) are not readiness items. A patient can use what exists. What they must not get is guidance nobody ratified, a deletion that does not delete, or a diary protected by controls nobody has tested.
- **A BAA.** No BAA is legally required while the product is direct-to-patient (ADR-0017). The day a provider offers this app to their patients, HIPAA applies, and this list needs a BAA row and a risk-analysis row before anything else.
