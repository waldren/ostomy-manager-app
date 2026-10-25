# The staging/Cognito spike: runbook (P4.S6)

This runbook deploys `infra/cdk`'s `OstomyStagingSpike` stack, runs its two proofs, records the results, and destroys it. It is the procedure for sprint P4.S6 (#168), exit criteria 5–7. The stack itself is described in [`infra/cdk/README.md`](../infra/cdk/README.md).

**This is not staging.** The spike proves two things and nothing more:

1. The API's OIDC claim mapping works against **real Cognito** with configuration alone.
2. The API container runs under **Fargate's health-check semantics**.

Everything else that staging must eventually prove (plan risk R2) is listed under [What this run does not prove](#what-this-run-does-not-prove).

**Synthetic data only.** No real patient's data goes anywhere near this stack, not even to reproduce something. Nothing in this runbook writes clinical data at all: both proofs use the health route and the two auth stubs, which read no table.

---

## Contents

- [Prerequisites](#prerequisites)
- [1. Deploy, with no API task](#1-deploy-with-no-api-task)
- [2. Create the database roles and run the migrations](#2-create-the-database-roles-and-run-the-migrations)
- [3. Start the API](#3-start-the-api)
- [4. Proof 1: real Cognito tokens](#4-proof-1-real-cognito-tokens)
- [5. Proof 2: Fargate's health-check semantics](#5-proof-2-fargates-health-check-semantics)
- [6. Results](#6-results)
- [7. Teardown](#7-teardown)
- [Cost](#cost)
- [What this run does not prove](#what-this-run-does-not-prove)

---

## Prerequisites

**An AWS account that holds nothing else.** Use a sandbox account, never the one production will live in.
- Prefer short-lived credentials (IAM Identity Center / `aws sso login`) to an access key.
- Nothing on the development host may hold a production credential (CLAUDE.md). A sandbox credential is not one, but the same reasoning says to keep it short-lived.
- Set a budget alert on the account before deploying. The stack's real cost risk is forgetting to destroy it (see [Cost](#cost)).

**On the machine you deploy from:**
- **AWS CLI v2**, configured for that account and the region you choose (`aws configure sso` or `AWS_PROFILE`).
  - Any region with CloudFront VPC origins works.
  - `us-east-1` is the cheapest default.
- **Docker running.** `cdk deploy` builds both images for `linux/amd64`. On an ARM machine that needs emulation and is slow.
- **Node and pnpm** per `docs/getting-started.md`, and `pnpm install` done.
- **A clean checkout of `main`.**
  - `bin/app.ts` refuses a checkout with uncommitted changes, because the images are stamped with `git rev-parse HEAD` and the API refuses an empty `BUILD_COMMIT`.
  - Slices 1–3 (#169, #170, #171) must be in it. On a `main` without #170, the migrate task fails on its first migration.
- **`pnpm verify` passing**, with Docker up, so the integration suites actually ran.

**Once per account and region**, bootstrap CDK. It creates the ECR repository and S3 bucket that `cdk deploy` uploads to, and those outlive the spike:

```sh
pnpm --filter @ostomy/infra-cdk cdk bootstrap
```

**For every command below**, from the repo root in a POSIX shell (Git Bash on Windows), define:

```sh
out() {
  aws cloudformation describe-stacks --stack-name OstomyStagingSpike \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
```

Every name the steps need is a stack output, so nothing has to be copied out of the console.

---

## 1. Deploy, with no API task

```sh
pnpm --filter @ostomy/infra-cdk cdk deploy
```

The API service is created with **zero tasks** (`apiDesiredCount` defaults to 0), and that is the only order that works.
- The database has no owner role, no `ostomy` database and no runtime role until step 2 has run, so an API task cannot start.
- CloudFormation waits for an ECS service to stabilise. With one task, the deployment circuit breaker would fail the service, and CloudFormation would roll back the entire stack, database included.

Expect 20–30 minutes. RDS and the CloudFront distribution take most of it. Record the time it took in the results table.

Then capture the outputs:

```sh
CLUSTER=$(out ClusterName)
SERVICE=$(out ServiceName)
SUBNETS=$(out TaskSubnetIds)
DB_TASK_SG=$(out DbTaskSecurityGroupId)
LOGS=$(out LogGroupName)
API=$(out ApiUrl)
echo "$API"
```

---

## 2. Create the database roles and run the migrations

Both are one-off Fargate tasks. Each must run in the stack's public subnets with a public IP: the stack has no NAT gateway, so without one a task cannot pull its image or read its secrets, and fails at `ResourceInitializationError`.

```sh
run_once() {  # $1 = task definition ARN; prints the task's exit code
  local task
  task=$(aws ecs run-task --cluster "$CLUSTER" --task-definition "$1" --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$DB_TASK_SG],assignPublicIp=ENABLED}" \
    --query 'tasks[0].taskArn' --output text)
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$task"
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" \
    --query 'tasks[0].[containers[0].exitCode, stoppedReason]' --output text
}

run_once "$(out DbBootstrapTaskDefinition)"
aws logs tail "$LOGS" --log-stream-name-prefix db-bootstrap --since 15m
```

**Expected:** exit code `0`, and in the log `created role ostomy_owner` then `created database ostomy`. A re-run says `updated role` and `already exists`, which is also fine.

```sh
run_once "$(out DbMigrateTaskDefinition)"
aws logs tail "$LOGS" --log-stream-name-prefix db-migrate --since 15m
```

**Expected:** exit code `0`, Prisma's `All migrations have been successfully applied`, then `set the password for ostomy_runtime`.

**If either fails**, the task prints only `failed: <message>`, never a connection string or a password. Common causes:

| Message | Cause |
| --- | --- |
| `ResourceInitializationError` in `stoppedReason` | The task got no public IP, or the wrong subnets. Check the `run-task` network configuration. |
| `self-signed certificate in certificate chain` / `unable to verify` | The image lacks the RDS CA bundle. It was built from a target other than `-aws`. |
| `must be able to SET ROLE` | The bootstrap script was changed so that the master creates the database. The owner must create it (`infra/cdk/README.md`). |
| `ostomy_runtime is a member of another role` | Someone granted the runtime role a membership. Revoke it and re-run (ADR-0011). |
| `permission denied to alter role` with `SUPERUSER` in it | The checkout predates #170. |

---

## 3. Start the API

```sh
pnpm --filter @ostomy/infra-cdk cdk deploy -c apiDesiredCount=1
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
curl -sS -w '\n%{http_code}\n' "$API/api/v1/health"
```

**Expected:** `200` with a liveness body. If the service never stabilises, read the API's own log:

```sh
aws logs tail "$LOGS" --log-stream-name-prefix api --since 15m
```

It refuses to boot, and says why, on a malformed issuer, an empty `BUILD_COMMIT`, or a runtime role with privileges it must not have.

**Every later `cdk deploy` must pass `-c apiDesiredCount=1`**, or it scales the API back to zero.

---

## 4. Proof 1: real Cognito tokens

Exit criterion 5. The stack configures each guard the way `docs/deployment-development.md` describes for Cognito:
- `OIDC_AUDIENCE_CLAIM=client_id`, because a Cognito access token has no `aud`;
- `OIDC_REQUIRED_TOKEN_USE=access`.

This proof shows real Cognito tokens meet that configuration with no code change.

### Create one synthetic user in each pool

The password is generated and only ever held in a shell variable. Cognito's default policy requires upper and lower case, a digit and a symbol, hence the suffix. `USER_PASSWORD_AUTH` is enabled on these clients for this step alone, and is one of the [spike-only settings](../infra/cdk/README.md#spike-only-settings-each-blocks-real-patient-data).

```sh
PATIENT_POOL=$(out PatientUserPoolId); PATIENT_CLIENT=$(out PatientClientId)
ADMIN_POOL=$(out AdminUserPoolId);     ADMIN_CLIENT=$(out AdminClientId)
PW="$(openssl rand -base64 18 | tr -d '/+=')Aa1!"

for pool in "$PATIENT_POOL" "$ADMIN_POOL"; do
  aws cognito-idp admin-create-user --user-pool-id "$pool" --username spike-user \
    --message-action SUPPRESS >/dev/null
  aws cognito-idp admin-set-user-password --user-pool-id "$pool" --username spike-user \
    --password "$PW" --permanent
done

tokens() {  # $1 = client id; prints "<access token> <id token>"
  aws cognito-idp initiate-auth --client-id "$1" --auth-flow USER_PASSWORD_AUTH \
    --auth-parameters "USERNAME=spike-user,PASSWORD=$PW" \
    --query 'AuthenticationResult.[AccessToken, IdToken]' --output text
}
read -r P_ACCESS P_ID <<<"$(tokens "$PATIENT_CLIENT")"
read -r A_ACCESS A_ID <<<"$(tokens "$ADMIN_CLIENT")"

claim() {  # $1 = token, $2 = claim name
  node -e 'const [t, c] = process.argv.slice(1); console.log(JSON.parse(Buffer.from(t.split(".")[1], "base64url"))[c])' "$1" "$2"
}
call() {  # $1 = token, $2 = path; prints the status and the body
  curl -sS -o /dev/stdout -w '  -> %{http_code}\n' -H "Authorization: Bearer $1" "$API$2"
}
```

**Before going on, check the shape you are relying on.** Each of these is what slice 1 was built against, and is what a test there already mints. If a real token differs, record it: it is a finding, not a problem with this step.

```sh
claim "$P_ACCESS" token_use   # access
claim "$P_ACCESS" client_id   # = $PATIENT_CLIENT
claim "$P_ACCESS" aud         # undefined
claim "$P_ID" token_use       # id
claim "$P_ID" aud             # = $PATIENT_CLIENT
claim "$P_ACCESS" iss         # https://cognito-idp.<region>.amazonaws.com/<PATIENT_POOL>
```

### The checks

| # | Request | Expected |
| --- | --- | --- |
| 1a | `call "$P_ACCESS" /api/v1/auth-stub` | **200**, `{"patientId":"<sub>"}`, where `<sub>` is `claim "$P_ACCESS" sub` |
| 1b | `call "$P_ID" /api/v1/auth-stub` | **401**. The ID token carries `aud`, and is refused as the wrong kind of token |
| 1c | `call "$A_ACCESS" /api/v1/auth-stub` | **401**. An admin token on a patient route: another issuer |
| 1d | `call "$A_ACCESS" /api/v1/admin/auth-stub` | **200**, `{"adminId":"<sub>"}` |
| 1e | `call "$P_ACCESS" /api/v1/admin/auth-stub` | **401**. A patient token on an admin route |
| 1f | `call "$A_ID" /api/v1/admin/auth-stub` | **401** |
| 1g | `call "${P_ACCESS}x" /api/v1/auth-stub` | **401**. The signature no longer verifies |
| 1h | `curl -sS -o /dev/null -w '%{http_code}\n' "$API/api/v1/auth-stub"` | **401**. No token |

Also check that **every response, the 401s included, carries `Cache-Control: no-store`**, and that CloudFront did not cache one: repeat 1a and look for `x-cache: Miss from cloudfront`.

```sh
curl -sS -D - -o /dev/null -H "Authorization: Bearer $P_ACCESS" "$API/api/v1/auth-stub" | grep -i -E 'cache-control|x-cache'
```

**Then read the API's log for those requests:**

```sh
aws logs tail "$LOGS" --log-stream-name-prefix api --since 15m
```

The log should show method, path and status, and **no token, no `sub` beyond what the route returns, and no email or username**. Anything else is a finding against the log serializers.

**Optional, if the hour allows:** the access token expires 60 minutes after issue. Repeat 1a after that, and expect **401**.

Clear the variables when done: `unset PW P_ACCESS P_ID A_ACCESS A_ID`.

---

## 5. Proof 2: Fargate's health-check semantics

Exit criterion 6. There are three observations.

**Keep a probe running throughout**, in a second shell, so each observation has a count of failed requests rather than an impression:

```sh
# second shell; API as above
while true; do
  printf '%s %s\n' "$(date -u +%H:%M:%S)" "$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$API/api/v1/health")"
  sleep 1
done | tee spike-probe.log
```

Count the non-200 lines in each window afterwards with `grep -v ' 200$' spike-probe.log`.

### 5a. Steady state on the ALB health check

```sh
TG=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].loadBalancers[0].targetGroupArn' --output text)
aws elbv2 describe-target-health --target-group-arn "$TG" \
  --query 'TargetHealthDescriptions[].[Target.Id, TargetHealth.State]' --output text
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].[runningCount, desiredCount, deployments[0].rolloutState]' --output text
```

**Expected:** one target `healthy`; running `1` of `1`; rollout `COMPLETED`.

### 5b. A task replacement

There are two kinds, and they should behave differently. Run both.

**A rolling replacement**, which is what every deploy does:

```sh
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment >/dev/null
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
```

**Expected:** **no** failed probe. The service runs between 100% and 200% of its tasks, so the new task is healthy on the ALB before the old one is drained (30-second deregistration delay). Record how long it took to stabilise.

**A task stopped out from under the service**, standing in for a task that dies:

```sh
TASK=$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --query 'taskArns[0]' --output text)
aws ecs stop-task --cluster "$CLUSTER" --task "$TASK" --reason 'P4.S6 replacement test' >/dev/null
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"
```

**Expected:** with one task, an outage of some seconds, after which ECS starts a replacement and it becomes healthy on its own. Record:
- the number of failed probes;
- the time from stop to the first 200 again.

This one is not a pass/fail. It is the number that says what one task means, and staging will run more than one.

### 5c. A clean stop on SIGTERM

The stop in 5b sent SIGTERM. Read what the stopped task reported:

```sh
aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$TASK" \
  --query 'tasks[0].[containers[0].exitCode, stoppingAt, stoppedAt, stoppedReason]' --output text
```

**What "clean" means here, and what to expect:**
- **The stop takes well under `stopTimeout` (30 s).** If the container took the full 30 seconds and then exited `137`, SIGTERM never reached node, and the init process in the task definition is not doing its job.
- **Expect exit code `143`** (128 + SIGTERM), within about a second.
  - That is what the image did on the desk, and it is still not graceful.
  - The API registers no shutdown hooks, so node exits on SIGTERM's default action rather than finishing in-flight requests.
  - On ECS the ALB deregisters the target before the stop, which covers most of that in practice.
  - Graceful shutdown is P9's. Record what you see.

---

## 6. Results

Fill this in during the run and commit it with the plan update (exit criterion 7).

**Run:** _date_ · **Commit:** _`git rev-parse HEAD`_ · **Region:** _region_ · **Operator:** _who_

| # | Check | Expected | Observed | Pass |
| --- | --- | --- | --- | --- |
| D1 | `cdk deploy` with no API task | Completes | _minutes_ | |
| D2 | `DbBootstrapTask` | Exit 0, role and database created | | |
| D3 | `DbMigrateTask` | Exit 0, all migrations applied, runtime password set | | |
| D4 | API scaled to 1 | Service stable, `/health` 200 through CloudFront | | |
| T0 | Real token shape | `token_use`, `client_id`, no `aud` on access; `aud` on ID; `iss` as configured | | |
| 1a | Patient access token, patient route | 200, `patientId` = `sub` | | |
| 1b | Patient ID token, patient route | 401 | | |
| 1c | Admin access token, patient route | 401 | | |
| 1d | Admin access token, admin route | 200, `adminId` = `sub` | | |
| 1e | Patient access token, admin route | 401 | | |
| 1f | Admin ID token, admin route | 401 | | |
| 1g | Altered signature | 401 | | |
| 1h | No token | 401 | | |
| 1i | `Cache-Control: no-store` on 200 and 401, CloudFront miss | Present, miss | | |
| 1j | API log for those requests | No token, email or username | | |
| 2a | Steady state | 1 healthy target, 1/1 running, rollout completed | | |
| 2b | Rolling replacement | 0 failed probes; _seconds_ to stable | | |
| 2c | Stopped task | Replaced unaided; _n_ failed probes, _seconds_ to 200 | | |
| 2d | SIGTERM | Exit 143 within ~1 s; not 137 after 30 s | | |
| X1 | `cdk destroy` | `DELETE_COMPLETE` | | |
| X2 | Residue checked | Only the bootstrap ECR images and template | | |

**Findings:** _anything that differed from expected, with what it means for staging (P9)._

---

## 7. Teardown

Destroy the stack the same day. The [cost](#cost) is small per hour and is not small per month.

```sh
pnpm --filter @ostomy/infra-cdk cdk destroy
aws cloudformation describe-stacks --stack-name OstomyStagingSpike 2>&1 | tail -1
# expect: "Stack with id OstomyStagingSpike does not exist"
```

The Cognito pools and their one synthetic user each go with the stack.

**If destroy fails on the VPC with `DependencyViolation`**, CloudFront's VPC-origin security group has not been removed yet. It is deleted asynchronously. Wait a few minutes and run `cdk destroy` again.

**Then check what a stack delete does not remove.** The template tests hold every stateful resource to `DeletionPolicy: Delete`, and the stack has no Lambda functions, so none of this should hold data. Each still has to be looked at:

```sh
# Deleted secrets can sit in a recovery window. Force-delete any that remain.
aws secretsmanager list-secrets --include-planned-deletion \
  --query "SecretList[?contains(Name, 'DbOwnerPassword') || contains(Name, 'DbRuntimePassword') || contains(Name, 'DatabaseSecret')].[Name, DeletedDate]" --output text
# aws secretsmanager delete-secret --secret-id <name> --force-delete-without-recovery

# No snapshot of the spike's database should exist; delete any that does.
aws rds describe-db-snapshots --query "DBSnapshots[?contains(DBInstanceIdentifier, 'ostomystagingspike')].DBSnapshotIdentifier" --output text

# Nothing tagged synthetic-only should remain.
aws resourcegroupstaggingapi get-resources --tag-filters Key=data-classification,Values=synthetic-only \
  --query 'ResourceTagMappingList[].ResourceARN' --output text
```

**What remains on purpose:** the images in the CDK bootstrap ECR repository (`cdk-hnb659fds-container-assets-*`) and the template in its bucket. They are code only, with no data or secret. Remove them with `cdk gc` if the account will not be used again, or delete the bootstrap stack (`CDKToolkit`) itself.

**Locally:** delete `spike-probe.log`, and close the shells that held the token variables.

---

## Cost

These are estimates from public on-demand prices in `us-east-1` at the time of writing. Check them against current pricing; the order of magnitude is what matters.

| Resource | Approx. per hour |
| --- | --- |
| RDS `db.t4g.micro`, single-AZ, 20 GB | $0.019 |
| Application Load Balancer, hours plus minimal LCUs | $0.025 |
| Fargate, one 0.25 vCPU / 0.5 GB task | $0.012 |
| Public IPv4 addresses (one per running task) | $0.005 each |
| Secrets Manager, three secrets, prorated | $0.002 |
| CloudFront, Cognito (free tier), CloudWatch Logs | ≈ $0 at this traffic |
| **Total, with the API running** | **≈ $0.06 / hour** |

**A run takes about two hours end to end, so expect under $0.50.** Left running, the same stack costs **about $45 a month**, which is why the budget alert is a prerequisite and teardown is the same day. The one-off tasks cost cents.

---

## What this run does not prove

These are R2's remaining risks (`design-specs/planning/v1-implementation-plan.md` §7), and none of them is settled by this run. They belong to real staging (P9):
- **Cognito beyond the token:** refresh-token rotation, MFA, the hosted UI and Authorization Code + PKCE with the real clients, and email verification and password reset. This run mints tokens with `USER_PASSWORD_AUTH` from the CLI.
- **TLS end to end:** this run terminates TLS at CloudFront, on its default certificate. The hops behind it are plain HTTP inside the VPC.
- **Customer-managed KMS keys, Multi-AZ, backups and disaster recovery.** The spike is single-AZ with AWS-managed keys and a one-day backup it deletes.
- **Load, and more than one task.**
- **The mobile and web clients against AWS.** Neither is pointed at this stack.

The full list of spike-only settings that must change before real patient data is in [`infra/cdk/README.md`](../infra/cdk/README.md#spike-only-settings-each-blocks-real-patient-data).
