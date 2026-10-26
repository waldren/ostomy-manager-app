# Self-hosted production stack

One Linux host running Docker Compose, under [ADR-0022](../../design-specs/decisions/0022-self-hosted-production-on-one-host.md). This is D.S1 (#173): the stack, its proxy allowlist and identity realms (slice 2), the deploy CLI that operates a host (slice 3a), and the tests that hold each to the ADR.

**Nothing here may hold real patient data yet.** A real host is initialised only:
- by the deploy CLI, run in the operator environment;
- from a release tag signed in the operator environment;
- after every row of [`docs/compliance/real-data-readiness.md`](../../docs/compliance/real-data-readiness.md) is signed;
- and it takes no patient account until `verify` passes against it.

Until then, everything below is for a **synthetic** host. A synthetic host is never promoted to real (ADR-0022 item 1).

## What is here

| Path | What it is |
|---|---|
| `compose.yml` | The stack. Read its header first. |
| `caddy/Caddyfile` | Caddy's global options: the ACME email, the admin API off, no HTTP/3. |
| `caddy/sites.caddy` | Every routing decision: the allowlist. |
| `keycloak/realms/` | The `patient` and `admin` realms, imported on Keycloak's first start. |
| `bin/generate-secrets.sh` | Generates the stack's secrets on the host. |
| `selfhost.env.example` | The host's own settings. Holds no secret. `init` writes the real file. |
| `cli/` | `ostomy-host`, the deploy CLI (`pnpm host`). See [Operating a host](#operating-a-host). |
| `src/` | The stack's tests (see [Tests](#tests)). |

## The services

```
internet ──80/443──▶ caddy ──┬──▶ web        (the SPA)
                             ├──▶ api ───────┬──▶ postgres     (clinical data)
                             │               └──▶ keycloak     (JWKS only)
                             └──▶ keycloak ─────▶ keycloak-db  (identities, login events)

operator ──ssh -L 8081──▶ caddy:8081 (host loopback) ──▶ keycloak   (administration console)
```

- **`caddy`** is the only service on a network with a route off the host (`edge`), and the only one that publishes a port.
- **The other networks are `internal`.** So the API, Keycloak and both databases cannot reach the internet, and the internet cannot reach them.
- **`db-setup`** runs once per deploy, before the API starts:
  1. It creates the migration owner (ADR-0011 Amendment 1) as the bootstrap superuser.
  2. It migrates as that owner.
  3. It sets the runtime role's password, as a SCRAM verifier.

  These are the same scripts the AWS spike runs (`infra/cdk/tasks`, built into the `migrate-selfhost` image target).
- **`keycloak-db` is a separate PostgreSQL server.** Nothing but Keycloak can reach it, and a Keycloak compromise does not reach the clinical database's network.
- **There is no object store.** Nothing uses one yet. P5.S3 decides what stores objects here (ADR-0022 Amendment 1).

## Operating a host

`ostomy-host` (`pnpm host <command>`, from the repository root) initialises, deploys and inspects a host over SSH. It runs as TypeScript under Node 24, with no build step.

```sh
pnpm host init   --host ops@203.0.113.5 --classification synthetic --release main \
                 --domain diary.example.org --auth-domain auth.diary.example.org \
                 --acme-email operator@example.org --admin-ip 198.51.100.7
pnpm host deploy --host ops@203.0.113.5 --release main
pnpm host status --host ops@203.0.113.5
pnpm host logs   --host ops@203.0.113.5 api --tail 100
```

(The addresses above are documentation examples; `--admin-ip` refuses them, as it refuses any non-public address.)

Exit status: `0` done, `1` refused (a gate said no, or the input was wrong), `2` unreachable, `3` an unexpected failure.

### Before the first `init`

- **A fresh Debian 12 or Ubuntu 22.04/24.04 VPS**, reached as root or as a user with passwordless sudo, by SSH key.
- **The host key in `known_hosts`, checked by hand.** The tool runs ssh with `BatchMode=yes`, so an unknown host key stops it rather than being trusted on first use. Connect once with plain `ssh`, and compare the fingerprint with the one in the provider's console.
- **DNS for both names pointing at the host**, or Let's Encrypt cannot issue and the first deploy's readiness check fails.
- **Docker and Compose in the operator environment.** The images are built there.

### What `init` does

Every refusal happens before anything on the host changes. Then, in this order:

1. **Records the classification** (`/etc/ostomy/classification`), once. A host is never re-classified, and a synthetic host is never promoted to real (ADR-0022 item 1). An `init` that fails partway can be re-run under the same classification only. A real host must also be fresh: no `/etc/ostomy` and none of the stack's volumes.
2. **Hardens the host:**
   - Docker from Docker's own apt repository, its signing key checked against the published fingerprint;
   - `ufw` allowing the SSH port in use (rate-limited), 80 and 443, and nothing else;
   - unattended security upgrades;
   - SSH by key only, checked with `sshd -T` against what sshd will actually enforce, not what the file says.
3. **Writes `/etc/ostomy/selfhost.env`** and **generates the secrets on the host** with the release's own `bin/generate-secrets.sh`. No secret is ever on the operator's machine.
4. **Deploys the release**, as `deploy` does.

**The admin allowlist takes public addresses only.** `--admin-ip` refuses private, loopback, link-local, documentation and reserved ranges in both families, and anything wider than /16 (IPv4) or /32 (IPv6). Behind Docker, an IPv6 client can arrive from the bridge gateway, a private 172.x address. A /32 then fails closed, but allowing a private range "to fix it" would admit every IPv6 client on the internet to the admin surface.

**Docker's own packages are not upgraded automatically.** Unattended upgrades cover the distribution's security updates; Docker comes from Docker's repository. Updating it is the operator's job.

### What `deploy` does

1. **Resolves the release** (see below), in this checkout.
2. **Builds** the API, migration and web images in a clean worktree of the release, with `docker compose build`, for the host's architecture. compose.yml stays the one definition of how each image is built, and every base image is pinned by digest there.
3. **Ships** them with `docker save | ssh ... docker load`, and refuses unless each loaded tag is the image ID just built. No registry sits between the build and the host.
4. **Installs** the release's stack files under `/opt/ostomy/releases/<release>/`, with a generated `release.override.yml` that removes every `build:` and pins each service to its release tag.
5. **Starts** the stack (`up --wait`), and refuses unless each running container is exactly the image built.
6. **Records** the release in `/etc/ostomy/release.json`, then checks `https://<domain>/api/v1/health/ready` from outside the host.

The host needs Docker Compose 2.24.4 or later (for `!reset`), and the tool refuses an older one.

**Migrations run while the previous release is still serving**, and nothing takes a backup first. A migration that drops or renames a column breaks the old API until the new one is up. Until slice 5 adds a backup before every migration, a release must keep its migrations additive (expand, then contract in a later release).

### Releases, and signing one

| Host | `--release` takes |
|---|---|
| synthetic | any commit, tag or branch. The host records it as `commit-<12 hex>`, or as the tag if it is a signed tag that verifies. |
| real | **only an annotated tag signed with an SSH key** listed in `--allowed-signers` (or `$OSTOMY_ALLOWED_SIGNERS`). The tool must also be run **from a clean checkout of that tag**, so the code deciding whether the gates pass is the reviewed, signed code. |

The allowed-signers file lists the operator environment's tag-signing key, and lives in the operator environment. **The tool refuses one inside the repository**, which the development host can write. A tag signed with an OpenPGP key is refused too: only an SSH signature is checked against that file. So is a tag ref pointing at a signed tag object that names a different release.

In the operator environment, after reviewing the diff since the previous release tag:

```sh
git config gpg.format ssh
git config user.signingkey ~/.ssh/ostomy-release-signing.pub   # ideally an ed25519-sk hardware key
git tag -s v1.0.0 -m "Release v1.0.0"
git switch --detach v1.0.0
pnpm host init --classification real --release v1.0.0 \
  --allowed-signers ~/.config/ostomy-host/allowed_signers ...
```

An allowed-signers line looks like `release@example.org namespaces="git" ssh-ed25519 AAAA...`.

**`init --classification real` also reads `docs/compliance/real-data-readiness.md` from the tag**, and refuses, naming each row, unless every row carries a `Name, YYYY-MM-DD` sign-off. Today every row is unsigned, so it refuses.

### Not yet in the tool

Slice 3b adds `verify`, which checks a host from outside (ADR-0022 item 4). Slice 3c adds the Keycloak realm apply, the `master` realm's OTP and bootstrap-administrator replacement, and account creation, which waits on `verify`. Until 3c, a realm-file edit reaches an existing host only by resetting a synthetic one.

### By hand, without the tool

For a throwaway synthetic host only, from a checkout on the host:

```sh
sudo infra/selfhost/bin/generate-secrets.sh /etc/ostomy/secrets
sudo cp infra/selfhost/selfhost.env.example /etc/ostomy/selfhost.env   # then edit it
sudo BUILD_COMMIT="$(git rev-parse HEAD)" \
  docker compose --env-file /etc/ostomy/selfhost.env -f infra/selfhost/compose.yml up -d --build --wait
```

`BUILD_COMMIT` is required. Without it the image bakes an empty commit, which the API refuses at boot.

## Secrets

`bin/generate-secrets.sh` writes one file per secret into a directory only root can enter. It never prints a value. It keeps a secret that already exists, because replacing a database password under a live volume locks the stack out of its own data. Rotation is a procedure (RD-14, slice 5), not a re-run.

Each service gets only the secrets it names. It reads them at start, in its own command:
- PostgreSQL reads its password file natively.
- The API, `db-setup` and Keycloak export the value inside a shell line and then `exec` the process.

**No value appears in an environment variable Compose sets, a build argument, an image, or `docker inspect`.** `compose.spec.ts` holds the file to that, and it was checked against a running stack. The secrets leave the host only inside encrypted backups (slice 5).

The files are mode 0444 inside a 0700 directory. Compose bind-mounts them into containers that run as their own non-root users, which must be able to read them. The directory is what keeps every other account on the host out.

## What the internet can reach

`caddy/sites.caddy` forwards an allowlist. Anything not named is answered by Caddy and never reaches a container.

| Host | Path | Goes to |
|---|---|---|
| `OSTOMY_DOMAIN` | `/api/v1/admin/*` | the API, **from `OSTOMY_ADMIN_ALLOWED_IPS` only**; otherwise 403 |
| | `/api/v1/health` | refused (404): liveness reports nothing a patient needs |
| | `/api/v1/*` | the API |
| | everything else | the web SPA |
| `OSTOMY_AUTH_DOMAIN` | `/realms/patient/protocol/openid-connect/*`, `/realms/patient/login-actions/*`, `/realms/patient/.well-known/*` | Keycloak |
| | the same three under `/realms/admin/` | Keycloak, **from `OSTOMY_ADMIN_ALLOWED_IPS` only**; otherwise 403 |
| | `/resources/*` | Keycloak (the login pages' assets) |
| | everything else, including `/admin/`, `/realms/master/`, the account console, `/metrics` and `/health` | refused (404) |
| loopback `:8081` | everything | Keycloak, for the administration console through an SSH tunnel |

**Transport.**
- TLS is 1.3 only, with HSTS on both names. Plain HTTP is redirected.
- There is no access log. It would record every `/?code=...` with the client's address (ADR-0022 item 14). The web container's nginx access log is off for the same reason.
- Caddy normalises a path before matching it, so `/api/v1/%61dmin/...`, `/api/v1/ADMIN/...` and `/api/v1/x/../admin/...` are admin paths to it, and are refused from outside the allowlist. The allowlist test asserts each of these.

**The administration console:** run `ssh -L 8081:127.0.0.1:8081 <host>`, then open `http://localhost:8081/admin/`. The local port must be 8081, because Keycloak is told that is where its console lives (`KC_HOSTNAME_ADMIN`).

## The Keycloak realms

`--import-realm` creates each realm from its file on Keycloak's **first** start, and leaves an existing realm alone. Editing a file therefore changes nothing on a host that already has the realm. Slice 3b's `verify` will diff a running realm against these files (RD-16), and slice 3c applies a changed one. Until then, a synthetic host is reset by removing its `keycloak-pgdata` volume.

`${OSTOMY_WEB_ORIGIN}` and `${OSTOMY_ADMIN_ORIGIN}` in the files are substituted from Keycloak's environment on import.

### Both realms

- **No self-service.** No registration and no password reset, because there is no SMTP (ADR-0022 item 8).
- **Brute-force detection is on.** After 5 failures an account waits a minute, rising to 15 minutes.
- **Password policy.** At least 12 characters for a patient and 14 for an administrator, with no composition rules (NIST SP 800-63B). A password may not be the username or the email.
- **Refresh tokens rotate, and each is single-use.**
- **No client takes a password grant**, including the built-in `admin-cli`, which the realm files override. The Keycloak test asserts this for every client in both realms, built-in ones included, by trying one.
- **The API's audience comes from a mapper on each app client.** No app client takes the `roles`, `profile` or `email` scope. So an access token's `aud` is the API alone, and the token carries no name, email or username.

### Session lifetimes, and what they mean for an offline phone

Item 5 asks for these to be chosen rather than inherited.

| | Patient realm | Admin realm |
|---|---|---|
| Access token | 5 minutes | 5 minutes |
| Browser session idle / maximum (the web SPA) | 30 minutes / 10 hours | 15 minutes / 8 hours |
| Offline session idle / maximum (the Android app) | **30 days / 90 days** | not offered |

**The Android app asks for `offline_access`. The web SPA is refused it.** An offline session is what lets a phone stay signed in through days without a connection. Its limits are the trade:

- **A phone that has not refreshed for 30 days** is answered `invalid_grant` on its next attempt. That covers a phone offline, or not opened, for that long. The app then clears the token, keeps the diary and the unsent entries (ADR-0014, #40), and tells the patient to sign in again.
- **Every 90 days a patient signs in again**, however often they use the app. A stolen refresh token is good for at most that long.
- **Two refreshes at once end the session.** Replaying a superseded refresh token is refused, and it also invalidates the newer one (ADR-0022 Amendment 1, measured). `apps/mobile`'s single-flight `renewAccessToken` is what keeps the phone from doing this to itself.

The web SPA's 30-minute idle timeout is SRS §5.2's server-side session timeout.

These are the officer's numbers to change (RD-5). Changing one is an edit to the realm file and, on a running host, slice 3c's realm apply.

### Patient realm

- **Two public clients, both PKCE `S256` with exact redirect URIs:**
  - `ostomy-patient-app`, redirecting to `ostomydiary://redirect`;
  - `ostomy-web`, redirecting to `${OSTOMY_WEB_ORIGIN}/`.
- **Allowed scopes:** `openid` for both, plus `offline_access` for the app. **Keycloak refuses a sign-in that asks for anything else** (`invalid_scope`).
  - The self-hosted web build asks for `openid`.
  - **Slice 4's release build must ask for `openid offline_access`.** The development `.env` also asks for `profile`.
- **Patients cannot edit their username, email or name.** Deleting the account is off too. A deletion outside ADR-0017's flow would orphan the patient's clinical data, and the email is where a breach notice goes. The account console is not routed anyway.
- **A temporary password stops at the change-password page.** No code is issued until the patient sets their own (ADR-0022 item 8).

### Admin realm

- **One public client, `ostomy-admin-console`, PKCE `S256`.** It redirects to `${OSTOMY_ADMIN_ORIGIN}/`. `apps/admin` does not exist yet, so nothing is served there.
- **Sign-in is a password and a one-time code, both required.** The realm's browser flow is its own (`admin browser`). Keycloak's default makes OTP *conditional*, which lets an account with no OTP sign in with its password alone.
- **OTP enrolment at sign-in is off** (`CONFIGURE_TOTP` is disabled). An account with no OTP credential is refused outright, rather than asked to enrol by whoever first holds its password. Administrators are created with OTP already enrolled by the operator (slice 3c).

### Not done here

These are slice 3c's, because they are operations on a running Keycloak, not realm files:
- the `master` realm's OTP requirement;
- replacing the bootstrap administrator with a named, OTP-enrolled one, and deleting the bootstrap account (RD-11).

## Tests

- **`pnpm --filter @ostomy/infra-selfhost test:unit`** needs no Docker. It runs:
  - `compose.spec.ts`: ports, networks, secrets, digests, log settings and the API's claim mapping;
  - `realms.spec.ts`: the realm files read as data;
  - `generate-secrets.spec.ts`: the secrets script;
  - the CLI's own tests in `cli/`, which need git, `ssh-keygen` and bash but no Docker and no host:
    - `release.spec.ts`: signed tags against real git and real SSH signatures: a stranger's key, an unsigned or lightweight tag, a renamed tag ref and an allowed-signers file inside the repository are each refused;
    - `readiness.spec.ts`: the real-data gate, against the committed checklist itself;
    - `host-scripts.spec.ts`: every script that runs as root on the host, through a real bash;
    - `commands.spec.ts`: `init` and `deploy` against a fake host, asserting each refusal happens before anything on the host changes;
    - `settings.spec.ts`: the admin allowlist's public-only rule, and that the settings file supplies everything compose.yml requires.
- **`pnpm --filter @ostomy/infra-selfhost test:integration`** runs:
  - `caddy.integration.spec.ts`, which starts the pinned Caddy image with `sites.caddy` unchanged, and asserts:
    - every forwarded path and every refused one;
    - the allowlist, with alternative spellings of admin paths;
    - TLS 1.2 refused, HSTS sent, and the HTTP redirect;
    - no request's URI or address in Caddy's log when an upstream is down;
  - `cli/override.integration.spec.ts`, which has Compose itself merge the release override and checks nothing is left to build.

**Nothing in CI runs `init` or `deploy` against a host.** The scripts are run through bash and the commands against a fake host, which proves their logic and their ordering, not that a Debian VPS accepts them. A synthetic host is the first place they run end to end.
- **`apps/api/src/auth/keycloak-realm.integration.spec.ts`** imports these realm files into the pinned Keycloak image. It signs in through the browser flow and hands the tokens to the API's real guards.

The integration suites skip without Docker, and refuse to skip when `CI` is set.

## What later slices add

- **Slice 3b:** `verify`, from outside the host: TLS, an external port scan, every refused path, the admin allowlist, ADR-0011's grants, PostgreSQL's log settings, an OTP-less admin refused, and each realm against its file.
- **Slice 3c:** the realm apply, the `master` realm's OTP and bootstrap-administrator replacement, and account creation gated on `verify`.
- **Slice 4:**
  - the signed Android release build, with `minSdkVersion` 29 and the scopes above;
  - a minimum client version.
- **Slice 5:**
  - encrypted off-host backups, a backup before every migration, and a restore that converges with phones;
  - monitoring of `/api/v1/health/ready`;
  - the runbook.
