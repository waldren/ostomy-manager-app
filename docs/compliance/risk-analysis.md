# Risk analysis

- **Owner:** [Security & Privacy Officer — TBD]
- **Last reviewed:** [ ]
- **Next review:** [ ]

## Status: started, not complete

This is a working register of risks the build has actually surfaced, not a completed formal analysis. It exists so that what is already known is written down somewhere other than commit messages and ADRs.

A formal analysis under HIPAA §164.308(a)(1)(ii)(A) is **not currently required** — that is an administrative safeguard, and this product is governed by the FTC Health Breach Notification Rule (`breach-notification.md`). It becomes required the moment a provider offers the app to their patients. Doing the work now is cheaper than doing it then, and the register below is most of the input.

## What holds PHI

| Where | What | Protection |
|---|---|---|
| PostgreSQL (`observations`, `medication_administrations`, …) | All clinical values | Runtime role is not the schema owner; no `UPDATE`/`DELETE` on `audit_events` (ADR-0011) |
| `audit_events.before_value` / `after_value` | Clinical values, as before/after state | Append-only by grant. Purgeable only by the ADR-0017 job, as the owner role, offline |
| Device SQLite (`apps/mobile`) | Observations and the sync queue | SQLCipher; key in `expo-secure-store`, device-bound; database bound to one OIDC subject (ADR-0014) |
| S3 | Photos, PDF exports | SSE-KMS, presigned URLs. **Not yet built** |
| In transit | Everything | TLS. **Not yet true in development** — the LAN stack is plain HTTP with synthetic data only |
| `apps/web` | Nothing at rest | Online-only by decision; `sessionStorage` holds the OAuth session only |

## Known risks

Ranked by the product's own judgement, not a scored matrix.

| # | Risk | Status |
|---|---|---|
| 1 | **Lost or stolen patient phone.** The most likely first incident. | Mitigated: encrypted at rest, device-bound key, session re-lock, enrolment invalidation (ADR-0014, ADR-0015). **Unverified on hardware** |
| 2 | **iOS cloud backup carries the database off-device.** `expo-file-system@57` removed the exclusion API | Partially mitigated: the file is ciphertext and its key does not migrate on restore. Gap is open and recorded (ADR-0014) |
| 3 | **A live coerced unlock.** Someone compels the patient to present a finger or face | **Not mitigated, and not mitigable client-side.** Accepted in ADR-0015 |
| 4 | **Shared or handed-down device leaking between patients** | Mitigated: database bound to one subject, purged on change or sign-out (ADR-0014) |
| 5 | **Deletion that does not delete.** Audit rows held clinical values the API could not purge | Mitigated by ADR-0017's privileged job. **Job not yet built** |
| 6 | **The privileged purge job itself.** ADR-0011's guarantee is now "no request can delete an audit row" rather than "nothing can" | Mitigated by role separation, offline invocation, and a `deletion_log`. Named as a pen-test target |
| 7 | **PHI in logs.** Would be silent and hard to reverse | Mitigated structurally: bodies never assembled into a log line; validation returns rule codes, never values. Asserted in the integration suite |
| 8 | **Untrusted payloads from offline devices** | Mitigated: every rule re-enforced server-side on every synced operation, never trusting client validation |
| 9 | **Development host compromise.** The self-hosted runner's `docker` group membership makes it total | Mitigated only by there being nothing valuable there. Synthetic data only, no production credential, ever |
| 10 | **Third-party error tracking exfiltrating PHI** | Not yet a risk — no crash-reporting sink exists. Flagged ahead of P2.S2b (`docs/sync-contract.md` §10) |
| 11 | **Staging parity.** Fargate orchestration, TLS, real Cognito and KMS are untested until staging exists | Open. `docs/deployment-development.md` lists what staging must cover |

## The honest gaps

- **No penetration test has been performed** (`penetration-testing.md`).
- **No device-side control is verified on hardware.** jest runs no keychain and cannot simulate biometric enrolment invalidation, so a green `pnpm verify` proves nothing about ADR-0014 or ADR-0015.
- **No usability review with representative patients**, which SRS_v2 §5.4 requires pre-launch. The accessibility reviewer made the point directly: no computation can tell you that copy reads wrong for its reader.
- **No formal likelihood/impact scoring.** Deliberate — a scored matrix assembled by the person who wrote the code tends to confirm what that person already believes.
- **Nothing here has been reviewed by anyone outside the build.**

## Review triggers

Beyond the scheduled review: any new third-party service in the PHI path, any change to auth or sync, the first provider relationship, and after any penetration test or incident.
