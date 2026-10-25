# infra/cdk: the P4.S6 staging/Cognito spike

One CDK stack, `OstomyStagingSpike` (`src/spike-stack.ts`), for sprint P4.S6 (#168). It proves two things and nothing more: the API's OIDC claim mapping works against real Cognito with configuration alone, and the API container runs under Fargate's health-check semantics. **It is not staging.** It is single-AZ, uses the smallest classes, has no NAT, WAF or real backups, and is destroyed after the run.

**Synthetic data only.** The stack is tagged `data-classification: synthetic-only`, and nothing in it may hold a real patient's data, ever (CLAUDE.md).

**Nothing here is deployed by `pnpm verify` or by CI.** Those only synthesise the stack and assert on the template. Deploying is a manual step, done when the maintainer has a sandbox account and asks for it.

## What is in it

| Piece | Shape | Why |
| --- | --- | --- |
| VPC | 2 AZs, public and isolated subnets, **no NAT** | NAT would be most of the hourly cost. The API tasks get a public IP for outbound traffic, and their security group admits only the ALB. |
| RDS PostgreSQL 17 | `db.t4g.micro`, single-AZ, encrypted, isolated subnets, `rds.force_ssl=1`, `log_error_verbosity=terse`, statement and parameter logging pinned off | The API cannot boot without its database (it checks the runtime role's privileges first). |
| Cognito | two user pools, patient and admin, each with one public client: no secret, OAuth disabled, no self sign-up | Disjoint pools (SRS §4.6). No OAuth means no `client_credentials` token, which would carry `client_id` and `token_use: access` too. |
| Fargate | one API task (**zero until asked**, see the deploy order below) behind an **internal** ALB, health-checked on `/api/v1/health`, with an init process so SIGTERM reaches node | Exit criterion 6. |
| CloudFront | HTTPS on the default `*.cloudfront.net` certificate, reaching the ALB through a **VPC origin** | TLS without owning a domain. The ALB has no public address at all. |
| One-off tasks | `DbBootstrapTask` (as the master user), `DbMigrateTask` (as the owner) | ADR-0011 Amendment 1. See below. |

## The database roles

ADR-0011 (Amendment 1) says the migrations run as an owner role that is **not** the RDS master user. On RDS that role holds `CREATEROLE` and `CREATEDB` and is not a superuser.

1. **`DbBootstrapTask`** (`tasks/db-bootstrap.cjs`) connects as the master user and creates `ostomy_owner`. Then, **connected as the owner**, it creates the `ostomy` database. On PostgreSQL 16+ the master cannot create a database owned by a role it cannot `SET ROLE` to. The integration test shows the refusal ("must be able to SET ROLE"). Granting the master that membership would be a privilege nobody needs.
2. **`DbMigrateTask`** connects as the owner. It runs `prisma migrate deploy`, which creates `ostomy_runtime` with `NOLOGIN` and no password. Then `tasks/runtime-password.cjs` gives that role its `LOGIN` and its password.

Neither script sends a password to the server. Each sends a SCRAM-SHA-256 verifier computed in the task, which PostgreSQL stores as given. A failing `ALTER ROLE` is written to the server log with its statement text by default, so a cleartext password there would reach anyone who reads `postgresql.log`. The integration test runs PostgreSQL with `log_statement=all` and asserts no password reaches the log.

Every connection verifies the server certificate against the RDS CA bundle. The `-aws` targets of `infra/docker/api.Dockerfile` bake that bundle in at `/opt/rds-ca/`, pinned by digest. This was tested locally against a PostgreSQL that accepts TLS only:
- with a certificate from an unrelated CA, or a hostname mismatch, the scripts, Prisma's migrate engine and the API all refuse to connect;
- with the right CA, everything succeeds.

**That was a one-time check, not a test.** The integration suite runs the scripts with `DB_TLS=off`, so the verified-TLS path in `tasks/db-common.cjs` is not exercised in CI. The template tests do pin the settings that select it: every task gets the CA file, none gets `DB_TLS`, and the migrate command says `sslaccept=strict`.

## Commands

```sh
pnpm --filter @ostomy/infra-cdk test:unit         # synthesise and assert (no AWS, no Docker)
pnpm --filter @ostomy/infra-cdk test:integration  # the task scripts against PostgreSQL 17 (Docker)
pnpm --filter @ostomy/infra-cdk synth             # the real app: stages both image contexts into cdk.out
```

The full runbook, `docs/deployment-staging-spike.md`, is P4.S6 slice 4 and does not exist yet. Until it does, the order is what matters:

1. **`cdk deploy`** with the default `apiDesiredCount=0`. The database has no owner, no `ostomy` database and no runtime role yet, so an API task could not start. CloudFormation waits for the service to stabilise, and with one task the circuit breaker would fail the create and roll back the whole stack, database included.
2. **Run `DbBootstrapTask`, then `DbMigrateTask`**, with `aws ecs run-task` in the `TaskSubnetIds` output's subnets, with the `DbTaskSecurityGroupId` security group and `assignPublicIp=ENABLED`. With no NAT, a task without a public IP cannot pull its image or read its secrets.
3. **`cdk deploy -c apiDesiredCount=1`.**
4. **`cdk destroy`**, then clean up what it leaves (below).

The images are stamped with the checkout's `git rev-parse HEAD`, because the API refuses to start with an empty `BUILD_COMMIT`. A checkout with uncommitted changes is refused, since HEAD would not name what the images contain; `-c buildCommit=<sha>` overrides that deliberately.

### What `cdk destroy` leaves behind

The template tests hold every stateful resource to `DeletionPolicy: Delete`, and the stack has no Lambda functions. Some things still survive the stack, none holding data:
- **Both images**, in the CDK bootstrap ECR repository (`cdk-hnb659fds-container-assets-*`), and the template in the bootstrap bucket. Remove them by hand or with `cdk gc`.
- **Deleted secrets** may sit in Secrets Manager's recovery window. Check with `aws secretsmanager list-secrets --include-planned-deletion` and force-delete them.
- **Any manual RDS snapshot.** Do not take one. If one was taken, delete it.
- **CloudFront's VPC-origin security group** is removed asynchronously and has been reported to block deleting the VPC (`DependencyViolation`). If destroy fails on the VPC, wait and retry.

## Deliberate choices that look like omissions

- **No CDK feature flags in `cdk.json`.** The assertion tests synthesise with a bare `App`, so flags set only in `cdk.json` would make the deployed stack differ from the tested one.
- **`restrictDefaultSecurityGroup: false`.** CDK implements it as a Lambda-backed custom resource. Lambda writes its own log group, outside the stack, and that log group survives `cdk destroy`. A test holds the stack to zero Lambda functions, and nothing is ever placed in the default security group.
- **`exactOptionalPropertyTypes` is off in this workspace's tsconfig.** aws-cdk-lib's jsii-generated types do not model it, and with it on, `Vpc` is not an `IVpc`.
- **Placeholder object-storage keys.** The API's config requires static keys, but on Fargate credentials come from the task role. Nothing uses object storage yet, so this is left for P5 (#168, finding 4).
- **The ALB admits the VPC's CIDR, not CloudFront's VPC-origin security group.** CloudFront creates that group only once the origin exists, so the stack cannot name it. The ALB is internal, so nothing outside the VPC reaches it either way.

## Spike-only settings: each blocks real patient data

These are fine for synthetic data and must change before anything real touches this shape (P9):
- **Plain HTTP behind CloudFront**, both to the ALB and from the ALB to the task, so bearer tokens and bodies cross the VPC unencrypted. Needs an HTTPS listener with an ACM certificate (an owned domain), a decision on TLS to the target, a custom domain with a TLS 1.2+ security policy, HSTS, and WAF.
- **Cognito:** MFA off (SRS §4.6 makes it mandatory for admin accounts), account recovery `NONE`, `USER_PASSWORD_AUTH` enabled (production uses authorization code + PKCE only), threat protection and deletion protection off.
- **Static object-storage keys** in the task definition the first time S3 is really used. The config must accept task-role credentials first.
- **Public IPs and unrestricted egress** on the tasks. Production wants private subnets, VPC endpoints or NAT, and egress limited to what the tasks call.
- **AWS-managed keys** for RDS, Secrets Manager and logs, where SRS §4.6 asks for customer-managed KMS keys.
- **The RDS master secret** lives as long as the stack and can bypass every grant. Restrict who can read it, and rotate it.
