# Security & Privacy Officer

- **Owner:** [Security & Privacy Officer — TBD]
- **Last reviewed:** [ ]
- **Next review:** [ ]

## Why this role exists here

The FTC Health Breach Notification Rule, which governs this product (see `breach-notification.md`), does **not** require a designated officer — that is a HIPAA administrative safeguard (§164.308(a)(2)), and HIPAA does not currently apply.

The role is kept anyway for two practical reasons. A breach procedure with no named decision-maker has no one to start its clock, and the 60-day deadline runs from discovery whether or not anyone has taken ownership. And every document in this directory is a control only while someone maintains it; an unowned compliance document is decoration that reads as diligence.

## Responsibilities

- Declares a breach and owns the notification clock (`breach-notification.md`).
- Maintains the risk analysis (`risk-analysis.md`) and schedules its review.
- Owns the penetration-testing cadence (`penetration-testing.md`) and decides what a finding blocks.
- Approves changes to the controls recorded in ADR-0011, ADR-0014, ADR-0015 and ADR-0017 — the four that carry security or privacy consequences.
- Reviews the service list in `docs/security-hipaa.md` when a new third-party service enters the PHI path. This is the check that fails silently: the person adding a service is a developer solving a different problem.

## Designation

| Field | Value |
|---|---|
| Name | [ ] |
| Role / title | [ ] |
| Effective date | [ ] |
| Backup / delegate | [ ] |

**Unfilled on purpose.** A role placeholder is an honest statement that the structure exists and the accountability does not yet. Fill this in before the first production PHI, not after.

## When this changes

If a clinic or provider offers this app to their patients — the likely route being SRS_v2 §3.5 Epic 5's share link — HIPAA applies, and §164.308(a)(2) makes this designation mandatory rather than voluntary, with a named individual. Workforce security-awareness training (§164.308(a)(5)) becomes mandatory at the same moment, and there is no document for it here because it does not currently apply.
