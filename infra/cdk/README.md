# infra/cdk: the P4.S6 staging/Cognito spike

One CDK stack, `OstomyStagingSpike` (`src/spike-stack.ts`), for sprint P4.S6 (#168). It proves two things and nothing more: the API's OIDC claim mapping works against real Cognito with configuration alone, and the API container runs under Fargate's health-check semantics. **It is not staging.** It is single-AZ, uses the smallest classes, has no NAT, WAF or real backups, and is destroyed after the run.

**Synthetic data only.** The stack is tagged `data-classification: synthetic-only`, and nothing in it may hold a real patient's data, ever (CLAUDE.md).

**Nothing here is deployed by `pnpm verify` or by CI.** Those only synthesise the stack and assert on the template. Deploying is a manual step, done when the maintainer has a sandbox account and asks for it.

## What is in it

| Piece | Shape | Why |
| --- | --- | --- |
| VPC | 2 AZs, public and isolated subnets, **no NAT** | NAT would be most of the hourly cost. The API tasks get a public IP for outbound traffic, and their security group admits only the ALB. |
| RDS PostgreSQL 17 | `db.t4g.micro`, single-AZ, encrypted, isolated subnets, `rds.force_ssl=1`, `log_error_verbosity=terse` | The API cannot boot without its database (it checks the runtime role's privileges first). |
| Cognito | two user pools, patient and admin, each with one public client: no secret, OAuth disabled, no self sign-up | Disjoint pools (SRS §4.6). No OAuth means no `client_credentials` token, which would carry `client_id` and `token_use: access` too. |
| Fargate | one API task behind an **internal** ALB, health-checked on `/api/v1/health`, with an init process so SIGTERM reaches node | Exit criterion 6. |
| CloudFront | HTTPS on the default `*.cloudfront.net` certificate, reaching the ALB through a **VPC origin** | TLS without owning a domain. The ALB has no public address at all. |
| One-off tasks | `DbBootstrapTask` (as the master user), `DbMigrateTask` (as the owner) | ADR-0011 Amendment 1. See below. |

## The database roles

ADR-0011 (Amendment 1) says the migrations run as an owner role that is **not** the RDS master user. On RDS that role holds `CREATEROLE` and `CREATEDB` and is not a superuser.

1. **`DbBootstrapTask`** (`tasks/db-bootstrap.cjs`) connects as the master user and creates `ostomy_owner`. Then, **connected as the owner**, it creates the `ostomy` database. On PostgreSQL 16+ the master cannot create a database owned by a role it cannot `SET ROLE` to. The integration test shows the refusal ("must be able to SET ROLE"). Granting the master that membership would be a privilege nobody needs.
2. **`DbMigrateTask`** connects as the owner. It runs `prisma migrate deploy`, which creates `ostomy_runtime` with `NOLOGIN` and no password. Then `tasks/runtime-password.cjs` gives that role its `LOGIN` and its password.

Every connection verifies the server certificate against the RDS CA bundle. The `-aws` targets of `infra/docker/api.Dockerfile` bake that bundle in at `/opt/rds-ca/`. This was tested locally against a PostgreSQL that accepts TLS only:
- with a certificate from an unrelated CA, or a hostname mismatch, the scripts, Prisma's migrate engine and the API all refuse to connect;
- with the right CA, everything succeeds.

## Commands

```sh
pnpm --filter @ostomy/infra-cdk test:unit         # synthesise and assert (no AWS, no Docker)
pnpm --filter @ostomy/infra-cdk test:integration  # the task scripts against PostgreSQL 17 (Docker)
pnpm --filter @ostomy/infra-cdk synth             # the real app: stages both image contexts into cdk.out
```

`cdk deploy` and `cdk destroy` are in the runbook, `docs/deployment-staging-spike.md`. The images are stamped with the checkout's `git rev-parse HEAD` (or `-c buildCommit=<sha>`), because the API refuses to start with an empty `BUILD_COMMIT`.

## Deliberate choices that look like omissions

- **No CDK feature flags in `cdk.json`.** The assertion tests synthesise with a bare `App`, so flags set only in `cdk.json` would make the deployed stack differ from the tested one.
- **`restrictDefaultSecurityGroup: false`.** CDK implements it as a Lambda-backed custom resource. Lambda writes its own log group, outside the stack, and that log group survives `cdk destroy`. A test holds the stack to zero Lambda functions, and nothing is ever placed in the default security group.
- **`exactOptionalPropertyTypes` is off in this workspace's tsconfig.** aws-cdk-lib's jsii-generated types do not model it, and with it on, `Vpc` is not an `IVpc`.
- **Placeholder object-storage keys.** The API's config requires static keys, but on Fargate credentials come from the task role. Nothing uses object storage yet, so this is left for P5 (#168, finding 4).
