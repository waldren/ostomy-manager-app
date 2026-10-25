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

And it collides with the development-host rule. A CLI that deploys over SSH means some machine holds a root-equivalent key to a server holding PHI. A sideloaded APK's signing key can push an "update" that inherits an installed patient's encrypted diary, because Android keeps an app's data across an upgrade signed with the same key. If both live on the development host, the rule is broken the first time anyone runs the tool.

## Decision

We will allow v1 production on **one self-managed Linux host running Docker Compose**. A host is initialised as either **synthetic** or **real** and never changes class. A **real** host is initialised only from an operator environment that is not the development host, and only after every item in `docs/compliance/real-data-readiness.md` is signed off.

The shape is below. Each item is binding on D.S1's later slices.

1. **A host's data classification is fixed when it is initialised.**
   - The CLI records it on the server. `init --classification real` refuses while any readiness item is unsigned.
   - **No host is ever promoted from synthetic to real.** The development host has had root on a synthetic host, so a host the development machine has ever reached is not eligible for real data.
   - A real-data server is a freshly provisioned VPS, initialised from the operator environment, with new secrets, new realms and an empty database. A synthetic host's data, keys and accounts never carry over.
2. **The operator environment is not the development host.** It is the only place that holds:
   - the SSH key to a real host;
   - the real release-signing keystore;
   - the private key that decrypts backups.

   Readiness item RD-4 names it. During the synthetic phase the development host may operate a synthetic server freely. That host holds synthetic data and a synthetic signing key, and nothing on it is valuable.
3. **Identity is Keycloak**, self-hosted in the same stack with its own database. It runs as two realms:
   - **`patient`**: a public client using authorization code + PKCE, with the `ostomydiary` redirect (ADR-0021) and the web SPA's redirect. Refresh tokens rotate, and a reused one is revoked.
   - **`admin`**: a separate realm with its own keys and issuer, and OTP required for every account.

   Realms in one Keycloak are a weaker separation than two Cognito pools, because they share a process and a database. They are still disjoint issuers with disjoint signing keys, which is what the API's two structurally separate guards check. The tokens are told apart by configuration alone:
   - the client is read from `aud`, through an audience mapper on each client;
   - `typ: Bearer` marks an access token, which refuses Keycloak's `typ: ID` ID token. This is the role `token_use` plays for Cognito.

   Keycloak's own administration console (the `master` realm) is **never routed by Caddy**. It is reachable only through an SSH tunnel.
4. **Patient accounts are created by the operator unless SMTP is configured.**
   - Self-registration in the `patient` realm stays off until a transactional mail provider is configured, because verification and password reset need email.
   - Whoever operates a real host already holds all of its data. The admin/patient boundary governs the admin *console* and the admin API, not the person with root.
5. **TLS is terminated by Caddy**, with certificates from Let's Encrypt.
   - Settings: TLS 1.3 only (§5.2), and HSTS.
   - Ports: only 80 and 443 are open. Port 80 exists solely for the ACME challenge and the redirect.
   - Inside the host: PostgreSQL, Keycloak, MinIO and the API are on an internal Docker network and publish no port.

   `/api/v1/admin/*` is restricted by Caddy to an operator IP allowlist, standing in for §4.6's network-restricted admin hosting. **TLS 1.3 only excludes Android 7–9**, which have no TLS 1.3 by default. The app's `minSdkVersion` is 24, so D.S1 slice 4 raises it to 29 (Android 10). This keeps §5.2 as written rather than weakening it.
6. **Secrets are generated on the server and never leave it.**
   - They live as files readable only by root and handed to containers as Compose secrets.
   - They are never in an image, an environment file in the repo, a build argument or a CLI argument.
   - The operator does not need to know them, and the CLI never prints them.

   This replaces Secrets Manager. There is no KMS: rotation is a CLI action, and the readiness checklist requires a rotation procedure to be written down.
7. **The database keeps ADR-0011 and the spike's log hygiene.**
   - Roles: the owner and runtime roles, with the runtime password set by a SCRAM verifier, never in cleartext (`infra/cdk/tasks/db-common.cjs`).
   - Logging: `log_error_verbosity=terse`, with statement and parameter logging pinned off.
8. **Backups are nightly, encrypted on the host to a public key, and copied off the host.**
   - The private key lives in the operator environment.
   - This replaces RDS automated backups and serves §5.3's RPO of 24 hours.
   - A backup counts as one only once a restore from the off-host copy has been carried out and timed against the 4-hour RTO (RD-7).
9. **The Android release is signed with a keystore generated in the operator environment.**
   - The synthetic phase uses a different, synthetic keystore. A tester's synthetic build therefore cannot upgrade into a real one, so the synthetic build's local diary is purged by reinstalling rather than inherited.
   - The build bakes in the server's URLs, has cleartext traffic off, and refuses performance marks (#163).
10. **Monitoring is an external uptime check** on `/api/v1/health`, plus container log rotation on the host.
    - This replaces CloudWatch's alarms in the weakest acceptable form.
    - The application logs carry no PHI by construction, so log storage on the host is not a new PHI store.

**AWS stays the architecture for scale, not a launch prerequisite.** SRS §4.6 is amended rather than replaced. When a provider relationship makes HIPAA apply, or availability needs more than one host, production moves to the AWS shape and this ADR is superseded.

## Consequences

**What this gets us.**

**Real patients on a timeline the maintainer controls**, at the cost of a VPS, with an architecture the existing code already supports. No application code changes: the token mapping, the object-store endpoint and the database roles are already configuration.

**The synthetic phase does real work.** It is the first time a release build on a real phone talks to a real HTTPS issuer, which is what HW-1 to HW-12 have been waiting for. It also gives a running target for the penetration test the compliance documents already make blocking.

**The readiness gaps stop living in prose.** The tooling refuses to initialise a real host until they are closed. This is the plan's R9 lesson ("a prose document has no failing test") applied at the point where forgetting would cost the most.

**What this costs.**

- **Availability.** One host has no failover. A kernel update, a disk failure or a provider incident is an outage, and recovery is a restore within §5.3's RTO, not a Multi-AZ switch. §5.3's 99.9% target is **at risk on this shape** and is not claimed. The offline-first mobile client absorbs outages for logging. `apps/web` does not, because it is online-only.
- **Self-operated security controls.** Patching the host OS, Docker, PostgreSQL, Keycloak and Caddy is now this project's job, not AWS's. Unattended security upgrades cover the OS. The images are this project's to bump.
- **Identity.** Keycloak is a large, capable system this project must configure correctly. A mistake in realm configuration is an authentication defect with no managed default to fall back on. The token integration test in D.S1 slice 2 proves the guards' side, not every realm setting.
- **Encryption at rest without KMS.**
  - Database files are protected by the provider's volume encryption, which the readiness checklist requires the provider to offer.
  - Backups are encrypted by this project, before they leave the host.
  - Disk encryption on a VPS whose key sits on the same VPS would be theatre, and is not claimed.
- **A second machine to keep.** The operator environment is a real cost for a single maintainer. It is the price of not amending the development-host rule, which this ADR declines to do.
- **Older phones.** Raising `minSdkVersion` to 29 drops Android 7–9 phones. These are older phones, and this patient population skews older. It is accepted because those OS versions stopped receiving security patches years ago and will be holding PHI. It is revisitable by allowing TLS 1.2 through an amendment to §5.2, not by quietly loosening Caddy.

**What it forecloses.**

Nothing structurally. The application code and data shape are identical across both production shapes. A move to AWS is:
1. a `pg_dump` restore into RDS;
2. a Keycloak user export into Cognito, or a migration flow that sends patients through a password reset;
3. new tokens on every device. A patient signs in again; their local diary survives, per ADR-0014's asymmetry.

The second step is the expensive one, and it gets more expensive with every patient. We would find out this was wrong at the first sustained outage, or the first provider relationship.

## Alternatives considered

| Alternative | Why not |
|---|---|
| Wait for AWS staging and production (P9) | The maintainer's call, and the reason this ADR exists. It remains the target for scale. |
| A managed IdP (Auth0, Okta, Clerk) instead of Keycloak | Puts every patient's email address with a new third party in the PHI path, at a price per user. Self-hosting keeps the identity data on the same host as everything else. Revisit if Keycloak's operating cost proves too high. |
| Authentik or Zitadel instead of Keycloak | Both are credible. Keycloak has the longest record as a certified OIDC provider, first-class realm separation, and documented refresh-token rotation with reuse revocation, which the mobile client's single-flight refresh depends on. |
| Keep the mock OIDC server | It lets anyone sign in as anyone. Disqualifying for any data at all on a public host, synthetic included. |
| Promote the synthetic host to real once the checklist is signed | The development host has had root on it. A host compromise there could have left anything on the server, and the development-host rule exists because that compromise is total. A fresh host costs minutes. |
| Run the CLI and sign releases on the development host, with hardware-backed keys (FIDO2 SSH key, PKCS#11 keystore) | It weakens a rule CLAUDE.md states without exception, and protects only against key theft, not against a compromised host using the key while it is plugged in. Reasonable later as an amendment, with the threat model written down. Not as a convenience in the first production ADR. |
| Allow TLS 1.2 and keep `minSdkVersion` 24 | Weakens a requirement §5.2 states, to serve OS versions without security patches. A real option, so it is named in Consequences as the route to reverse this. |
| Full-disk encryption (LUKS) on the VPS | The key would have to be on the VPS for unattended reboots, so it protects against nothing the provider's volume encryption does not already cover. |
| Kubernetes, or a PaaS | One host and one Compose file are what one maintainer can operate. A PaaS reopens the third-party question for the whole stack. |

## Spec impact

**Spec update required.** SRS_v2 goes to **v2.8**:
- **Header:** a v2.8 note.
- **§4.6:** amended. Production may be one self-managed host, with each AWS service's replacement named, and AWS is retained as the target for scale.
- **§4.7:** amended. The production environment is either shape, and synthetic and real hosts are never the same host.
- **§4.8:** amended. An external uptime check plus host log rotation, in place of CloudWatch, on the self-hosted shape.
- **§5.3:** a note. The 99.9% target is not claimed on one host.

`CLAUDE.md` is updated in the same change: the version and ADR count, the infrastructure line, and a paragraph on the self-hosted shape. Also updated:
- `design-specs/planning/v1-implementation-plan.md`: D.S1 is claimed.
- `docs/architecture.md`, `docs/security-hipaa.md` and `docs/compliance/risk-analysis.md`: each states the AWS-only production claim independently.

## Compliance and safety review

**Yes, this changes where PHI lives and who operates its protections.** `hipaa-compliance-reviewer` reviews this ADR and every later D.S1 slice, and is blocking on them.

- **No technical safeguard is removed.** TLS, audit logging, role separation, the admin identity boundary, MFA for admins and on-device encryption all stand. Several move from a managed service to a self-operated one, which is named under Costs.
- **The FTC framing is unchanged.** The hosting provider is a third-party service provider under 16 CFR 318.4. The readiness checklist requires its breach-notification terms to be recorded. `breach-notification.md`'s procedure is otherwise unaffected.
- **The readiness checklist is the safety gate.** Its clinical items (#144) are patient-safety items, not compliance paperwork. A patient shown an unratified high-output warning is shown it as guidance.

## Notes

- Readiness items are numbered RD-1 onward and their IDs are never reused, so issues and the CLI can cite them.
- Whether the operator environment may itself be a hardened VM or a cloud workstation is left to RD-4's sign-off. The requirement is only that the development host has never had access to it.
