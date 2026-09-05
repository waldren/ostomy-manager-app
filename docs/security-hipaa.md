# Security & HIPAA Practices (Developer Guide)

Developer-facing practices for handling PHI and meeting the HIPAA requirements in the SRS.

## From the SRS (design-specs/requirements/)

- Encryption of PHI at rest and in transit (TLS 1.3+)
- OAuth 2.0 / OpenID Connect authentication, with biometric login support on mobile
- Automated session timeouts
- Business Associate Agreements (BAAs) required with any cloud providers used

## Developer practices

These are settled rules, not guidance. Where a rule can be enforced by tooling it is, because a rule that depends on memory fails eventually — and here it fails silently.

### Never log PHI

- **No clinical value, patient identifier, or free-text note may reach application logs, error tracking, or crash breadcrumbs.** Request/response body logging is off at logger configuration time, not filtered later.
- **Validation errors return field identifiers and rule codes, never the offending value.** `volume: TIER_1_NEGATIVE`, never `volume 250 rejected`. Rejection responses are logged on the client too.
- Sentry (or equivalent) ships with `beforeSend` redaction from the first client, with request bodies and breadcrumbs disabled. This is not deferred to hardening.
- Prisma query logging with parameter values is never enabled anywhere that could see real data.
- Audit events are the _only_ place before/after PHI values are written, and they go to an append-only store separate from application logs.

### No real PHI outside production

- Development and staging use **synthetic or de-identified data only** — not temporarily, and not to reproduce a bug.
- Test fixtures and seed scenarios are generated, never sampled from a real dataset. Names, dates of birth, and identifiers are fabricated. See [ADR-0009](../design-specs/decisions/0009-synthetic-seed-data-generation.md).
- The shared development host is LAN-only, plain HTTP, and its CI runner is in the `docker` group — meaning a host compromise there is total. The only defence that holds is that there is nothing valuable on it. Keep it that way.
- Production is the only environment permitted to hold real PHI, and only after the pre-launch gate.

### Secrets

- **Never commit a `.env`.** `.gitignore` covers it and `scripts/check-no-committed-env.sh` fails CI on a force-added one.
- `.env.example` is the only committed environment file and contains **placeholders only** — the same check rejects anything resembling a real credential in it.
- No production or staging credential is ever placed on the development host.
- Runtime secrets come from the platform (AWS Secrets Manager in deployed environments), never from source, never from a build argument, never baked into an image.
- A leaked credential is rotated first and investigated second.

### Provider-agnostic auth and storage

Two rules that exist because development does not run on AWS:

- **Never import a Cognito SDK into request handling.** The API takes a standard OIDC issuer, JWKS URI, audience, and claim mapping as configuration; Cognito-specific behaviour goes behind a provider adapter.
- **Never assume AWS-hosted S3.** Endpoint, region, credentials, and path-style addressing are configuration. MinIO requires path-style, so virtual-host-style URL assumptions break development outright.

### The admin/patient boundary

The admin console has zero PHI access, and the boundary is enforced at the **identity layer** — a separate user pool, a structurally separate guard — not by authorization logic. A shared guard with a role check is a defect, not a shortcut. The `no-restricted-imports` rule in `packages/config/eslint` fails the build if `apps/admin` imports a patient data type. See [ADR-0008](../design-specs/decisions/0008-admin-config-api-before-console.md).

### Dependencies

- `pnpm audit` runs on every PR and fails on **high and critical**. Moderate findings are reported without blocking, so a transitive advisory with no available fix cannot halt all work — but they are reviewed, not ignored.
- Adding a dependency that touches PHI paths, auth, or crypto warrants a `hipaa-compliance-reviewer` pass on the PR.

### Review

`hipaa-compliance-reviewer` runs on any change touching PHI paths, audit logging, auth or authorization, logging or error tracking, seed or test data, infrastructure, or the admin boundary. It is read-only by design: it reports, and the PR applies the fixes. See `docs/git-workflow.md` for when it is blocking rather than advisory.

### Still open — do not invent answers

These are blocked on counsel, not on engineering, and are deliberately absent above: the **PHI retention period and deletion SLA**, **penetration-test cadence**, **BAA execution**, and **breach-notification procedure with a designated Security/Privacy Officer**. Do not implement a retention policy against a guessed number.

See also `design-specs/compliance/` for the product/compliance-level documentation.
