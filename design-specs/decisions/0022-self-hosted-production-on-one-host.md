# ADR-0022: Production may run on one self-managed Linux host, gated by a signed readiness checklist

- **Status:** Accepted
- **Date:** 2026-10-25
- **Deciders:** Steven Waldren
- **Related:** SRS_v2 §4.1, §4.3, §4.6, §4.7, §4.8, §5.2, §5.3 | [ADR-0008](0008-admin-config-api-before-console.md) | [ADR-0011](0011-database-roles-and-audit-immutability.md) | [ADR-0014](0014-local-phi-encryption-and-device-ownership.md) | [ADR-0017](0017-phi-retention-deletion-and-the-audit-exception.md) | [ADR-0021](0021-redirect-route-completes-oidc-flow.md) | `docs/compliance/real-data-readiness.md` | sprint D.S1, #173

## Context

SRS §4.6–4.7 put production on AWS: Fargate, RDS Multi-AZ, Cognito, S3 with KMS, Secrets Manager, and CloudWatch. Production is "a separate AWS account, and the only environment permitted to hold real PHI". None of it exists. P4.S6 (#168) built a throwaway spike that has not yet been run, and staging is P9.

The maintainer wants to serve real patients sooner than that, from **one Linux VPS running Docker**. Four answers were given on 2026-10-25:
- **Data:** real patients.
- **Network:** a domain, with Caddy and Let's Encrypt, and only ports 80 and 443 public.
- **Android:** a locally built, signed release APK, sideloaded.
- **Server:** a VPS reached over SSH.

### What is already settled and is not reopened here

- **The provider-abstraction rule (§4.3).** The API takes an OIDC issuer, JWKS URI, audience and claim mapping, and an object-store endpoint, as configuration. That rule is what makes this ADR possible without application changes. P4.S6 slice 1 (#169) added the claim names, so a token's client and its "this is an access token" marker can be read from whatever claims an issuer uses.
- **The compliance framing (ADR-0017).** The product is direct-to-patient, so the FTC Health Breach Notification Rule governs, not HIPAA, and no BAA is legally required. Every technical safeguard is still built to HIPAA's bar, voluntarily.
- **The database roles (ADR-0011).** There is an owner role and a runtime role, append-only is enforced by grant, and nothing runs as a superuser.
- **The admin boundary (§4.6, ADR-0008).** The identity layer is disjoint, and admins must use MFA.
- **The development host rule (CLAUDE.md).** Nothing on the development host may hold real PHI or a production credential, "not temporarily, not to reproduce a bug".

### What makes this a decision rather than a deploy script

Moving production off AWS means replacing every managed service with something this project operates itself:
- **Identity:** Cognito.
- **Secrets and keys:** Secrets Manager and KMS.
- **Backups and failover:** RDS automated backups and Multi-AZ.
- **Logs and alarms:** CloudWatch.

Each replacement is a control this project now runs. The SRS chose Cognito over "a self-hosted identity service" specifically to reduce custom auth surface. That reasoning is not wrong. This ADR accepts its cost knowingly.

It also exposes three gaps that would make "real patients" wrong today, whichever host is chosen:
- The clinical numbers have never been ratified by a clinician (#144).
- The device-side controls have never run on hardware (#39).
- ADR-0017's purge has a policy and no mechanism (P5.S7).

A deployment tool that installs a production server without asking about those gaps would make it easy to skip them.

And it collides with the development-host rule. A CLI that deploys over SSH means some machine holds a root-equivalent key to a server holding PHI, and that machine also pushes the code the server runs. A sideloaded APK's signing key can push an "update" that inherits an installed patient's encrypted diary, because Android keeps an app's data across an upgrade signed with the same key. If both live on the development host, the rule is broken the first time anyone runs the tool.

## Decision

We will allow v1 production on **one self-managed Linux host running Docker Compose**.
- A host is initialised as either **synthetic** or **real**, and never changes class.
- A **real** host is initialised only from an operator environment that the development host has never had administrative access to.
- It is initialised only from a signed release, and only after every item in `docs/compliance/real-data-readiness.md` is signed off.
- It accepts no patient account until it has passed a verification of its own configuration.

The shape is below. Each item is binding on D.S1's later slices.

1. **A host's data classification is fixed when it is initialised.**
   - The CLI records the classification on the server.
   - `init --classification real` refuses while any readiness item is unsigned. The checklist it reads is the one inside the signed release being deployed (item 3), not a working copy.
   - **No host is ever promoted from synthetic to real.** The development host has had root on every synthetic host.
   - A real-data server is a freshly provisioned VPS, in its own provider account (item 2), with new secrets, new realms and an empty database. No synthetic host's data, keys or accounts carry over.
2. **The operator environment is not the development host. It holds every credential that controls a real host, and nothing syncs between it and the development host.** The credentials are:
   - the SSH key to the real host;
   - the release-signing key for tags (item 3);
   - the Android release keystore;
   - the private key that decrypts backups;
   - the VPS provider account. Its console, rescue mode and snapshots are root and the disk. It is a different account (or project) from any synthetic host's;
   - the DNS account. Repointing the domain gets a valid certificate issued, which HSTS cannot stop. A CAA record restricts issuance to Let's Encrypt and pins this project's ACME account (`accounturi`);
   - the off-host backup store's administrative credentials.

   **The rules on these:**
   - Every account above uses hardware-key MFA.
   - **No password manager vault, cloud-synced folder or browser profile is shared** between the operator environment and the development host. On a Windows workstation, OneDrive and browser sync are the realistic leak.
   - The release keystore and the backup private key are also **escrowed offline**, for example on encrypted media in a safe. Losing the keystore means no update can ever reach an installed patient. Losing the backup key makes every backup useless.

   Readiness item RD-4 names the environment and evidences each of these. During the synthetic phase the development host may operate a synthetic server freely. That host holds synthetic data and a synthetic signing key, and nothing on it is valuable.
3. **Real hosts run only signed releases, built from that tag where the build can be trusted.**
   - The development host pushes to the repository that every image, the CLI and the APK are built from. So moving the keys alone would let a compromised development host ship a backdoor for the operator to deploy.
   - A release is a tag **created and signed in the operator environment**, after the diff since the previous release tag has been reviewed there.
   - The CLI verifies the tag's signature against an operator-environment key, then deploys images **pinned by digest** that were built from that tag. Two build routes are acceptable: building in the operator environment, or GitHub-hosted CI with build provenance that the CLI verifies.
   - The release APK is built in the operator environment from the same tag.
   - The readiness checklist is read from that tag, so a sign-off typed into the file by anyone else is never what the CLI checks. Without this, "signed off" would be a text format and not a signature.
4. **A real host serves no patient until `verify` passes against it.** The CLI's `verify` runs from outside the host after `init`, and after every deploy. It must pass before a patient account can be created. It checks:
   - TLS 1.3 only, and HSTS;
   - only ports 80 and 443 open (an external port scan);
   - every refused path in item 6, refused;
   - the admin allowlist;
   - ADR-0011's grants on `audit_events`;
   - PostgreSQL's log settings;
   - an OTP-less admin refused;
   - the most recent backup, present off-host and encrypted;
   - each realm's settings identical to the committed export (item 6).

   Every check on the readiness list was gathered on a synthetic host, and this is the step that checks the host that will actually hold the data.
5. **Identity is Keycloak**, self-hosted in the same stack with its own database, on an `auth.` subdomain so an XSS in `apps/web` cannot drive Keycloak's same-origin pages. It runs as two realms:
   - **`patient`**: a public client using authorization code + PKCE, with the `ostomydiary` redirect (ADR-0021) and the web SPA's redirect. Refresh tokens rotate, and a superseded refresh token is refused. Whether Keycloak also revokes the session when a superseded token is replayed is **not assumed**: D.S1 slice 2 tests it and records the answer.
   - **`admin`**: a separate realm with its own keys and issuer.

   **The realm separation and how tokens are told apart.** Realms in one Keycloak are a **weaker separation than two Cognito pools**. They share a process and a database, and the `master` realm can create users in either realm or remove the `admin` realm's OTP requirement. They are still disjoint issuers with disjoint signing keys, which is what the API's two structurally separate guards check. The tokens are told apart by configuration alone:
   - the API's audience is read from `aud`, through an audience mapper on each app client and never through a default client scope, so that built-in clients such as `account-console` and `admin-cli` never carry it. The requesting client is in `azp`;
   - `typ: Bearer` marks an access token, which refuses Keycloak's `typ: ID` ID token. This is the role `token_use` plays for Cognito.

   **Realm settings are committed as an export and diffed by `verify`:**
   - brute-force detection on;
   - a password policy;
   - direct access grants (ROPC) off on every client in both realms;
   - session lifetimes chosen deliberately. The defaults (30 minutes idle, 10 hours maximum) are SRS §5.2's server-side session timeout, but they also end an offline phone's session with `invalid_grant`. So the lifetime is a decision recorded in the export, not a default inherited;
   - in the patient account console, account deletion and email changes are off. Deleting an account outside ADR-0017's flow orphans the patient's PHI, and the email address is the contact a breach notice goes to;
   - `KC_HOSTNAME` is pinned with strict hostname checking, so the issuer and every emailed link ignore the Host header.

   **Admin MFA is OTP, required for every `admin` and `master` account, with no exception.** Keycloak's default *conditional* OTP lets a user with no OTP configured sign in with a password alone. The bootstrap `master` administrator is deleted once a named, OTP-enrolled one exists. OTP enrolment on first sign-in is trust-on-first-use, so admin accounts are created with OTP enrolled by the operator, never left for the first person holding the password.
6. **Caddy forwards an allowlist, never a denylist.**
   - **Public:** the API's patient routes; the web SPA; and the `patient` realm's endpoints only (`/realms/patient/protocol/openid-connect/*`, `/realms/patient/login-actions/*`, the static resources, and discovery).
   - **Behind the operator IP allowlist:** `/api/v1/admin/*`, standing in for §4.6's network-restricted admin hosting, and the `admin` realm's endpoints.
   - **Refused:** everything else, including `/admin/`, `/realms/master/`, `/metrics` and `/health`. D.S1 slice 2 asserts each refusal.
   - **Keycloak's administration console** is reachable only through an SSH tunnel, from the operator environment.
7. **TLS is terminated by Caddy**, with certificates from Let's Encrypt.
   - Settings: TLS 1.3 only (§5.2), and HSTS.
   - Ports: only 80 and 443 are open. Port 80 exists solely for the ACME challenge and the redirect.
   - Inside the host: PostgreSQL, Keycloak, MinIO and the API are on an internal Docker network and publish no port.

   **TLS 1.3 only excludes Android 7–9**, which have no TLS 1.3 by default. The app's `minSdkVersion` is 24, so D.S1 slice 4 raises it to 29 (Android 10). This keeps §5.2 as written rather than weakening it.

   **MinIO's S3 port is not routed while nothing uses object storage.** When P5.S3 adds presigned URLs, which clients must reach, that sprint decides between proxying objects through the API and routing the S3 API on its own hostname. Either way, MinIO's console is never routed.
8. **Patient accounts are created by the operator unless SMTP is configured.**
   - **Self-registration** stays off until a transactional mail provider is configured, because verification and password reset need email. That provider then joins the PHI-path service list and gets the notice in item 12.
   - **First passwords** are temporary, carry Keycloak's `UPDATE_PASSWORD` required action, and are handed over through a channel that is itself recorded as part of the PHI path.
   - **A password reset without SMTP** is the operator acting on someone's word, which makes it an account-takeover path. SRS §5.2 asks for MFA on password reset. Readiness item RD-18 requires either a reset that meets §5.2, or an explicit amendment of §5.2 by the maintainer. It is not assumed either way here.
   - **Every account needs a breach-notice contact.** It has a recorded contact method, and the patient's consent to receive notices there (RD-17), because a breach notice must reach a patient (16 CFR 318.5).
   - **The operator holds all of a real host's data**, and the admin/patient boundary governs the admin *console* and the admin API, not the person with root. An operator reading PHI through `psql` or a shell is **not audited by the application**. So a break-glass rule applies: PHI tables are touched only under a recorded incident, and SSH and `auditd` session logs are shipped off the host (RD-19).
9. **Secrets are generated on the server.**
   - They live as files readable only by root and are handed to containers as Compose secrets. They are never in an image, an environment file in the repo, a build argument, a CLI argument, or `docker inspect` output.
   - `apps/api` reads `DATABASE_URL` and the object-storage keys from environment variables, and Keycloak reads its database password from one. So D.S1 slice 2 either adds `*_FILE` support or an entrypoint that reads `/run/secrets` and starts the process. That is a small, named application change. It is not "no change".
   - The operator does not need to know the secrets, and the CLI never prints them.
   - **They leave the host only inside encrypted backups.** A Keycloak backup holds the realm signing keys and the password hashes.

   This replaces Secrets Manager. There is no KMS: rotation is a CLI action, and RD-14 requires the procedure to be written down.
10. **The database keeps ADR-0011 and the spike's log hygiene.**
    - Roles: the owner and runtime roles, with the runtime password set by a SCRAM verifier, never in cleartext (`infra/cdk/tasks/db-common.cjs`).
    - Logging: `log_error_verbosity=terse`, with statement and parameter logging pinned off.
11. **Backups are nightly, encrypted on the host to a public key, and copied to an append-only off-host store.**
    - The private key lives in the operator environment.
    - The host's credentials to the store can write but **cannot delete or overwrite**, through object lock or an append-only bucket, so ransomware on the host cannot take the backups with it.
    - This replaces RDS automated backups and serves §5.3's RPO of 24 hours. WAL archiving, which would lose far less, is considered in D.S1 slice 5.

    **A restore is not just a `pg_restore`.** Two things go wrong with a plain restore:
    - It rewinds every `server_sequence` to the backup's value, while devices hold cursors past it. `docs/sync-contract.md` §5.1 echoes a too-high `since` unchanged, so rows written after the restore reuse sequence numbers below those cursors and never reach the devices, which is ADR-0013's failure.
    - Entries a phone pushed after the backup are gone from the server, but the phone has marked them synced and will not push them again.

    So **before real data**, the sync contract and the restore procedure must gain three things:
    - every sequence advanced past the highest value ever issued, from an off-host high-water mark;
    - a server **generation** identifier, which tells a device to re-sync from `since=0` and re-push local rows the server does not have;
    - a replay of `deletion_log` before traffic is served, so a restore never brings back a patient ADR-0017 already purged.

    RD-7's evidence is a restore that a device synced after the backup converges with, not only a timed one.

    **Backup retention must fit ADR-0017's deletion window**, or backups keep a deleted patient's clinical values past the 30-day purge. The retention period is a Security & Privacy Officer and counsel decision (RD-3), not a number this ADR or the code picks.
12. **The FTC rule reaches every third-party service provider in the PHI path.** Under 16 CFR 318.3(b), a provider (defined in 318.2) must notify us of a breach, and we must notify each provider that we are a vendor of personal health records. RD-6 requires:
    - that notice, sent to the VPS provider and the off-host backup store;
    - the officer from RD-5 named in it as the contact;
    - their acknowledgement.

    The same applies to a mail provider on the day it is added.
13. **The Android release is signed with the operator keystore**, built from a signed tag (item 3).
    - The synthetic phase uses a different, synthetic keystore, so a tester's synthetic build cannot upgrade into a real one and inherit its diary.
    - The build bakes in the server's URLs, has cleartext traffic off, and refuses performance marks (#163).
    - **Sideloading has no automatic update.** Two things follow (RD-21):
      - the API enforces a **minimum client version**, with an "update required" response, so a security fix can reach patients who would otherwise never reinstall;
      - there is one published HTTPS download location, with the signing certificate's SHA-256, so a patient can check where the app came from.
14. **Logs: the API's carry no PHI by construction; Caddy's and Keycloak's must be configured not to.**
    - `apps/api` never assembles a body into a log line and strips query strings.
    - **Caddy's access log** would record the full URI, query string included (`/redirect?code=...`), along with the client IP and user agent. Under the FTC framing, an IP address or email address tied to an ostomy app is identifiable health information in itself. So it stays off, or a filter drops the query string and truncates the IP.
    - **Keycloak's event log** records usernames and IPs on failed logins. It is a PHI store with a defined retention, listed in `docs/compliance/risk-analysis.md`, not an operational log.
15. **Monitoring sees an outage, a stale backup and an intrusion attempt.** The weakest acceptable replacement for CloudWatch is:
    - **An external check on a readiness endpoint** that checks the database and the issuer's JWKS. `/api/v1/health` is liveness only, and answers 200 while PostgreSQL or Keycloak is down.
    - **A dead-man's switch on backup age**, because an unnoticed backup failure is an unnoticed breach of the RPO.
    - **Alerts** on disk usage, certificate expiry, and SSH and admin-realm authentication events.
    - **Container log rotation** on the host.

    Under the FTC rule, a breach counts as discovered when it would have been known with reasonable diligence (RD-20).

**AWS stays the architecture for scale, not a launch prerequisite.** SRS §4.6 is amended rather than replaced. When a provider relationship makes HIPAA apply, or availability needs more than one host, production moves to the AWS shape and this ADR is superseded.

## Consequences

**What this gets us.**

**Real patients on a timeline the maintainer controls**, at the cost of a VPS. The architecture is one the existing code supports, needing only small application changes:
- reading secrets from files (item 9);
- a readiness endpoint (item 15);
- a minimum-client-version check (item 13);
- the restore-safe sync additions (item 11).

The token mapping, the object-store endpoint and the database roles are already configuration.

**The synthetic phase does real work.** It is the first time a release build on a real phone talks to a real HTTPS issuer, which is what HW-1 to HW-12 have been waiting for. It also gives a running target for the penetration test the compliance documents already make blocking.

**The readiness gaps stop living in prose.** The tooling refuses to initialise a real host until they are closed, and refuses patient accounts until the real host itself has been checked. This is the plan's R9 lesson ("a prose document has no failing test") applied at the point where forgetting would cost the most. **It guards against forgetting. It is a guard against forgery only because the checklist is read from a tag signed in the operator environment.**

**What this costs.**

- **Availability.** One host has no failover. A kernel update, a disk failure or a provider incident is an outage, and recovery is a restore within §5.3's RTO, not a Multi-AZ switch. §5.3's 99.9% target is **at risk on this shape** and is not claimed. The offline-first mobile client absorbs outages for logging. `apps/web` does not, because it is online-only.
- **Self-operated security controls.** Patching the host OS, Docker, PostgreSQL, Keycloak and Caddy is now this project's job, not AWS's. Unattended security upgrades cover the OS. The images are this project's to bump.
- **Identity.** Keycloak is a large, capable system this project must configure correctly. Its defaults are not safe for this use (brute-force detection off, conditional OTP, direct grants on), and a mistake in realm configuration is an authentication defect with no managed default to fall back on. The committed export and `verify` catch drift from a reviewed configuration, not a reviewed configuration that is wrong. That is the penetration test's job (RD-8).
- **Weaker safeguards than §4.6 and §5.2 describe**, stated plainly rather than as "nothing removed":
  - **No managed secrets store and no KMS.** Root-only files and a written rotation procedure take their place.
  - **Provider volume encryption that the customer cannot verify**, in place of customer-managed keys. RD-6's evidence is the provider's claim.
  - **No server-side encryption on MinIO objects.** It does not matter until P5.S3 stores photos, and that sprint must decide it.
  - **Realm separation weaker than disjoint pools** (item 5).

  Disk encryption on a VPS whose key sits on the same VPS would be theatre, and is not claimed.
- **A second environment to keep, and more ceremony.** The operator environment, signed release tags, separate provider and DNS accounts, and offline escrow are real costs for a single maintainer. They are the price of not amending the development-host rule, which this ADR declines to do.
- **Separation of duties is mostly absent.** With one maintainer, the developer, operator, officer and signer are one person. Only RD-1, RD-8 and RD-10 involve an outside party. The checklist asks for a second reviewer wherever one can be found, and asks every row to say so when none can.
- **Older phones.** Raising `minSdkVersion` to 29 drops Android 7–9 phones, and this patient population skews older. It is accepted because those OS versions stopped receiving security patches years ago and will be holding PHI. It is revisitable by allowing TLS 1.2 through an amendment to §5.2, not by quietly loosening Caddy.

**What it forecloses.**

Nothing structurally: the data shape is identical across both production shapes. **But a move to AWS is not cheap, and every patient makes it dearer.** It means:
1. a `pg_dump` restore into RDS, with item 11's sequence and generation handling;
2. a Keycloak user export into Cognito, or a migration flow that sends patients through a password reset;
3. **a subject remap.** Cognito issues new `sub` values, and `patients.oidc_subject` would need a crosswalk migration. ADR-0014 also destroys a phone's local database whenever the signed-in subject changes, so **unsent entries on every phone would be lost** unless the client is first taught to recognise a remapped subject.

Steps 2 and 3 are the expensive ones. We would find out this was wrong at the first sustained outage, or the first provider relationship.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Wait for AWS staging and production (P9) | The maintainer's call, and the reason this ADR exists. It remains the target for scale. |
| A managed IdP (Auth0, Okta, Clerk) instead of Keycloak | Puts every patient's email address with a new third party in the PHI path, at a price per user. Self-hosting keeps the identity data on the same host as everything else. Revisit if Keycloak's operating cost proves too high. |
| Authentik or Zitadel instead of Keycloak | Both are credible. Keycloak has the longest record as a certified OIDC provider, first-class realm separation, and refresh-token rotation, which the mobile client's single-flight refresh depends on. |
| Keep the mock OIDC server | It lets anyone sign in as anyone. Disqualifying for any data at all on a public host, synthetic included. |
| Promote the synthetic host to real once the checklist is signed | The development host has had root on it. A host compromise there could have left anything on the server, and the development-host rule exists because that compromise is total. A fresh host costs minutes. |
| Run the CLI and sign releases on the development host, with hardware-backed keys (FIDO2 SSH key, PKCS#11 keystore) | It weakens a rule CLAUDE.md states without exception, and protects only against key theft, not against a compromised host using the key while it is plugged in, or shipping code. Reasonable later as an amendment, with the threat model written down. Not as a convenience in the first production ADR. |
| Move the keys but deploy whatever is on `main` | The development host can push to `main`. That would move the keys and leave the code that runs production in the development host's hands (item 3). |
| Allow TLS 1.2 and keep `minSdkVersion` 24 | Weakens a requirement §5.2 states, to serve OS versions without security patches. A real option, so it is named in Consequences as the route to reverse this. |
| Full-disk encryption (LUKS) on the VPS | The key would have to be on the VPS for unattended reboots, so it protects against nothing the provider's volume encryption does not already cover. |
| Kubernetes, or a PaaS | One host and one Compose file are what one maintainer can operate. A PaaS reopens the third-party question for the whole stack. |

## Spec impact

**Spec update required.** SRS_v2 goes to **v2.8**:
- **Header:** a v2.8 note.
- **§4.6:** amended. Production may be one self-managed host, with each AWS service's replacement named, and AWS is retained as the target for scale.
- **§4.7:** amended. The production environment is either shape, synthetic and real hosts are never the same host, and the deploy CLI deploys signed releases.
- **§4.8:** amended. The monitoring in item 15 and the log rules in item 14 apply on the self-hosted shape.
- **§5.2:** a note. On this shape the managed secrets store and KMS are replaced as item 9 describes, and MFA on password reset is RD-18's to settle.
- **§5.3:** a note. The 99.9% target is not claimed on one host.

`CLAUDE.md` is updated in the same change: the version and ADR count, the infrastructure line, the admin-console line, and a paragraph on the self-hosted shape. Also updated:
- `design-specs/planning/v1-implementation-plan.md`: D.S1 is claimed.
- `docs/architecture.md`, `docs/security-hipaa.md`, `docs/compliance/risk-analysis.md` and `docs/compliance/breach-notification.md`.

## Compliance and safety review

**Yes, this changes where PHI lives and who operates its protections.** `hipaa-compliance-reviewer` reviews this ADR and every later D.S1 slice, and is blocking on them. Its first review of this ADR found the gaps this revision closes (see Notes).

- **Some safeguards are weakened, and the ADR says which** (Consequences). TLS, audit logging, role separation, the admin identity boundary, MFA for admins and on-device encryption all stand, several of them now self-operated.
- **New stores of identifiable data are named:**
  - Keycloak's database, which holds the patient roster and login events;
  - Caddy's and Keycloak's logs, if enabled;
  - the backups;
  - the operator environment.

  ADR-0017's purge must reach the Keycloak user and their events, and backup retention must fit its window (RD-3).
- **The FTC framing is unchanged, and its third-party duties are now explicit** (item 12): 16 CFR 318.2 and 318.3(b), and the notice method in 318.5 (RD-17).
- **The readiness checklist is the safety gate.** Its clinical items (#144) are patient-safety items, not compliance paperwork. A patient shown an unratified high-output warning is shown it as guidance.
- **This is not a compliance determination.** Whether state law also applies (California's CMIA, Washington's My Health My Data Act, state breach statutes), whether the product meets the 2024 HBNR definition of a personal health record, and GDPR exposure are questions for counsel (RD-22).

## Amendment 1 — what slice 2 measured and settled (2026-10-25, D.S1 slice 2)

The decision stands. Slice 2 built the stack in `infra/selfhost/` and answered four things the decision left open.

**A replayed refresh token ends the session, not only itself.** Item 5 asked for this to be measured rather than assumed. On Keycloak 26.7, with the committed realm, replaying a superseded refresh token is refused with `invalid_grant`. The newer token, which nobody replayed, is then refused too. A stolen refresh token used after the phone has rotated it signs the patient out, which is the safe direction. It also means two overlapping refreshes from one phone end a good session. `apps/mobile`'s `renewAccessToken` is single-flight for that reason, and must stay so. `apps/api/src/auth/keycloak-realm.integration.spec.ts` pins the behaviour, so a Keycloak upgrade that changes it fails a test.

**Secrets reach each process through its own start command**, which is item 9's entrypoint route rather than `*_FILE` support in `apps/api`:
- PostgreSQL reads its password file natively.
- The API, the database setup and Keycloak read theirs in a shell line that exports the value and then `exec`s the process.

No application code changed for this, and `docker inspect` shows the command, never a value. That was checked against a running stack.

**MinIO is not in the stack.** Item 7 already kept its S3 port unrouted while nothing uses object storage. Nothing in the API uses object storage at all yet, so the service is left out rather than run unused, and MinIO's upstream no longer publishes the image the development stack pins. The API's object-storage settings are placeholders, as on the AWS spike. P5.S3 decides what stores objects on this host.

**The app clients get `openid` and nothing else**, plus `offline_access` for the Android app. There is no `profile`, `email` or `roles` scope, so an access token carries no name, email or username, and `aud` is the API alone. Keycloak refuses a sign-in that asks for a scope its client does not have. So the self-hosted web build asks for `openid`, and slice 4's release build must ask for `openid offline_access`. The development `.env` asks for `profile` as well, and would fail at sign-in.

The session lifetimes item 5 asked to be chosen deliberately are recorded, with their consequence for an offline phone, in `infra/selfhost/README.md`.

## Notes

- **ADR-0022 was revised in place on the day it was accepted, 2026-10-25, and nothing had been built on it.** It merged (#174) before the blocking compliance review that #173 requires had run, so the review is treated as part of its acceptance rather than as a later change. The review found:
  - the development host could still ship code to a real host, and several root-equivalent accounts were missing from the operator environment;
  - a plain restore loses and hides clinical data, and backups and the IdP sat outside ADR-0017's purge;
  - Caddy's and Keycloak's logs were not covered by "no PHI by construction";
  - no check ran on the real host itself;
  - Keycloak's exposure was defined by what was not routed;
  - the FTC citation was wrong (318.4 is timeliness).

  From the next amendment on, this ADR follows the immutability rule like any other.
- Readiness items are numbered RD-1 onward and their IDs are never reused, so issues and the CLI can cite them.
- Whether the operator environment may itself be a hardened VM or a cloud workstation is left to RD-4's sign-off. The requirement is only that the development host has never had administrative access to it, and that nothing syncs between the two.
