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
| Keycloak's database (self-hosted, ADR-0022) | The patient roster (email, name) and login events with IP addresses. Tied to this app, an identity is health information | On the host; never published. ADR-0017's purge must delete the user and their events (RD-3) |
| Caddy and Keycloak logs (self-hosted) | IP addresses, usernames and URLs, if enabled | Caddy's access log off, or filtered to drop query strings and truncate IPs; Keycloak's event log treated as a PHI store with a defined retention |
| Backups (self-hosted) | Everything in PostgreSQL and Keycloak, including realm signing keys and password hashes | Encrypted on the host to a key held only in the operator environment; append-only off-host store; retention to fit ADR-0017 (RD-3) |
| The operator environment (self-hosted) | No PHI at rest, but every credential that reaches it | Not the development host; nothing synced between them; hardware-key MFA on every account (RD-4) |

## Known risks

Ranked by the product's own judgement, not a scored matrix.

| # | Risk | Status |
|---|---|---|
| 1 | **Lost or stolen patient phone.** The most likely first incident. | Mitigated: encrypted at rest, device-bound key, session re-lock, enrolment invalidation (ADR-0014, ADR-0015). **Unverified on hardware** |
| 2 | **Consumer cloud backup carries the database off-device.** Neither Apple nor Google will execute a BAA for consumer backup | Mitigated on the shipping platform: `allowBackup: false` on Android. The iOS half — an open gap in ADR-0014, since `expo-file-system@57` removed the exclusion API — is **closed by scope**, not by a plugin: v1 ships no iOS client (ADR-0020). It returns if that platform does |
| 3 | **A live coerced unlock.** Someone compels the patient to present a finger or face | **Not mitigated, and not mitigable client-side.** Accepted in ADR-0015 |
| 4 | **Shared or handed-down device leaking between patients** | Mitigated: database bound to one subject, purged on change or sign-out (ADR-0014) |
| 5 | **Deletion that does not delete.** Audit rows held clinical values the API could not purge | Mitigated by ADR-0017's privileged job. **Job not yet built** |
| 6 | **The privileged purge job itself.** ADR-0011's guarantee is now "no request can delete an audit row" rather than "nothing can" | Mitigated by role separation, offline invocation, and a `deletion_log`. Named as a pen-test target |
| 7 | **PHI in logs.** Would be silent and hard to reverse | Mitigated structurally: bodies never assembled into a log line; validation returns rule codes, never values. Asserted in the integration suite |
| 8 | **Untrusted payloads from offline devices** | Mitigated: every rule re-enforced server-side on every synced operation, never trusting client validation |
| 9 | **Development host compromise.** The self-hosted runner's `docker` group membership makes it total | Mitigated only by there being nothing valuable there. Synthetic data only, no production credential, ever |
| 10 | **Third-party error tracking exfiltrating PHI** | Not yet a risk — no crash-reporting sink exists. Flagged ahead of P2.S2b (`docs/sync-contract.md` §10) |
| 11 | **Staging parity.** Fargate orchestration, TLS, real Cognito and KMS are untested until staging exists | Open. `docs/deployment-development.md` lists what staging must cover |
| 12 | **A self-hosted production host has no failover** (ADR-0022). Any host or provider failure is an outage, and recovery is a restore | Accepted. §5.3's uptime target is not claimed on this shape. RPO and RTO rest on off-host encrypted backups and a timed restore (`real-data-readiness.md` RD-7). The mobile client keeps logging offline, and `apps/web` does not |
| 13 | **Self-operated controls** (ADR-0022): OS, Docker, PostgreSQL, Keycloak and Caddy patching, and Keycloak realm configuration, which used to be AWS's or Cognito's job | Open until D.S1 ships: unattended OS security upgrades, pinned images bumped by this project, and a token integration test for the guards' side of the realm configuration. A realm misconfiguration is not caught by that test, so it is a named pen-test target (RD-8) |
| 14 | **Operator credentials.** The real host's SSH key, the tag-signing key, the release keystore (which can sign an "update" that inherits an installed patient's diary), the backup decryption key, and the provider, DNS and backup-store accounts | Mitigated by keeping them only in an operator environment the development host has never had administrative access to, with nothing synced between them (ADR-0022, RD-4). The keystore and backup key are escrowed offline. A synthetic host and a synthetic keystore are used until then, and a synthetic host is never promoted |
| 15 | **The development host ships code to production.** It pushes to the repository every image and the APK are built from | Mitigated by deploying only release tags signed in the operator environment after a diff review, with images pinned by digest (ADR-0022 item 3, RD-15) |
| 16 | **A restore loses and hides clinical data.** Sequences rewind below device cursors, phones never re-push entries they marked synced, and a restore can bring back a purged patient | Open. The sync contract needs a high-water mark, a server generation, and a `deletion_log` replay before real data (ADR-0022 item 11, RD-7) |
| 17 | **The operator reads PHI outside the application's audit.** Root on the host bypasses every application control | Mitigated procedurally: a break-glass rule, and SSH and `auditd` session logs shipped off the host (RD-19). Not mitigable technically on one host |

## The honest gaps

- **No penetration test has been performed** (`penetration-testing.md`).
- **No device-side control is verified on hardware.** jest runs no keychain and cannot present a biometric or a passcode to an OS prompt, so a green `pnpm verify` proves nothing about ADR-0014 or ADR-0015. #116 is the demonstration: a patient who could not present a biometric was locked out of their own diary, every unit test passed throughout, and two of those tests actively held the defect in place.
- **No usability review with representative patients**, which SRS_v2 §5.4 requires pre-launch. The accessibility reviewer made the point directly: no computation can tell you that copy reads wrong for its reader.
- **No formal likelihood/impact scoring.** Deliberate — a scored matrix assembled by the person who wrote the code tends to confirm what that person already believes.
- **Nothing here has been reviewed by anyone outside the build.**

## Review triggers

Beyond the scheduled review: any new third-party service in the PHI path, any change to auth or sync, the first provider relationship, and after any penetration test or incident.
