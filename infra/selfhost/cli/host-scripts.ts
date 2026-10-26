/*
Copyright (C) 2026 Steven E. Waldren

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU Affero General Public License as published
by the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU Affero General Public License for more details.

You should have received a copy of the GNU Affero General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The scripts that run on the host, as root, one per step.
 *
 * Two rules keep them safe to generate. Every value interpolated into one
 * goes through `shq`. And a file's content travels base64-encoded, so no
 * content, however it is written, can end a heredoc early or be read as shell.
 * `host-scripts.spec.ts` runs each through `bash -n`.
 */
import { checkReleaseName } from './release.ts';
import { shq } from './process.ts';
import { SECRETS_DIR, SETTINGS_PATH } from './settings.ts';

export const OSTOMY_ETC = '/etc/ostomy';
export const CLASSIFICATION_PATH = `${OSTOMY_ETC}/classification`;
export const RELEASE_RECORD_PATH = `${OSTOMY_ETC}/release.json`;
export const RELEASES_DIR = '/opt/ostomy/releases';
/** compose.yml's `name:`. Every volume and container carries it. */
export const COMPOSE_PROJECT = 'ostomy';

/**
 * The oldest Compose that runs this stack: `!reset` in the release override
 * (2.24.4), and `--wait` treating a one-off that exited 0 as done rather than
 * failed, which older 2.x releases did not (D.S1 slice 2 review).
 */
export const MIN_COMPOSE_VERSION = [2, 24, 4] as const;

/** Docker's apt signing key, as published at docs.docker.com/engine/install. */
export const DOCKER_APT_KEY_FINGERPRINT = '9DC858229FC7DD38854AE2D88D81803C0EBFCD88';

export const SERVICES = [
  'caddy',
  'postgres',
  'db-setup',
  'api',
  'web',
  'keycloak-db',
  'keycloak',
] as const;
export type Service = (typeof SERVICES)[number];

/** The images a release builds, by the Compose service that runs each. */
export const BUILT = {
  'db-setup': 'ostomy/api-migrate',
  api: 'ostomy/api',
  web: 'ostomy/web',
} as const;
export type BuiltService = keyof typeof BUILT;

const PRELUDE = 'set -euo pipefail\numask 022\n';

/** sshd_config including the drop-in directory the hardening writes to. */
const SSHD_INCLUDE_PATTERN = '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\\.d/\\*\\.conf';

/** The operating systems the hardening script supports. */
export const SUPPORTED_OS = ['debian', 'ubuntu'] as const;

/** A Docker image ID, the only shape interpolated into a host script as one. */
export const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

/** Writes `content` to `path` atomically, with `mode`. */
export function writeFile(path: string, content: string, mode: string): string {
  const encoded = Buffer.from(content, 'utf8').toString('base64');
  return [
    `tmp="$(mktemp ${shq(`${path}.XXXXXX`)})"`,
    `printf '%s' ${shq(encoded)} | base64 -d >"$tmp"`,
    `chmod ${shq(mode)} "$tmp"`,
    `mv -f "$tmp" ${shq(path)}`,
  ].join('\n');
}

/**
 * What the host is, in `key=value` lines: OS, architecture, classification,
 * whether a release was ever deployed, and Docker. Read-only.
 */
export function probeScript(): string {
  return `${PRELUDE}
. /etc/os-release
echo "os=$ID"
echo "codename=\${VERSION_CODENAME:-}"
echo "arch=$(uname -m)"
if [ -f ${shq(CLASSIFICATION_PATH)} ]; then echo "classification=$(head -n 1 ${shq(CLASSIFICATION_PATH)})"; else echo "classification="; fi
if [ -f ${shq(RELEASE_RECORD_PATH)} ]; then echo "deployed=yes"; else echo "deployed=no"; fi
if [ -d ${shq(OSTOMY_ETC)} ]; then echo "etc=yes"; else echo "etc=no"; fi
# Where this session comes from and in on, so init can refuse a firewall
# that would shut the operator out before it changes anything.
echo "ssh_client=$(printf '%s' "\${SSH_CONNECTION:-}" | awk '{print $1}')"
echo "ssh_port=$(printf '%s' "\${SSH_CONNECTION:-}" | awk '{print $4}')"
if grep -Eq ${shq(SSHD_INCLUDE_PATTERN)} /etc/ssh/sshd_config 2>/dev/null; then echo "sshd_include=yes"; else echo "sshd_include=no"; fi
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "compose=$(docker compose version --short)"
  echo "volumes=$(docker volume ls -q --filter label=com.docker.compose.project=${COMPOSE_PROJECT} | wc -l)"
else
  echo "compose="
  echo "volumes=0"
fi
`;
}

export interface Probe {
  os: string;
  codename: string;
  arch: string;
  classification: string;
  deployed: boolean;
  etc: boolean;
  compose: string;
  volumes: number;
  /** The address this SSH session arrives from, as the host sees it. */
  sshClient: string;
  sshPort: string;
  /** Whether sshd_config reads the drop-in the hardening writes. */
  sshdInclude: boolean;
}

export function parseProbe(stdout: string): Probe {
  const values = new Map(
    stdout
      .split('\n')
      .filter((line) => line.includes('='))
      .map(
        (line) =>
          [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()] as const,
      ),
  );
  const get = (key: string) => values.get(key) ?? '';
  return {
    os: get('os'),
    codename: get('codename'),
    arch: get('arch'),
    classification: get('classification'),
    deployed: get('deployed') === 'yes',
    etc: get('etc') === 'yes',
    compose: get('compose').replace(/^v/, ''),
    volumes: Number(get('volumes') || '0'),
    sshClient: get('ssh_client'),
    sshPort: get('ssh_port'),
    sshdInclude: get('sshd_include') === 'yes',
  };
}

export function composeIsRecentEnough(version: string): boolean {
  const parts = version.split(/[.+-]/).slice(0, 3).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    if (parts[i]! !== MIN_COMPOSE_VERSION[i]) return parts[i]! > MIN_COMPOSE_VERSION[i]!;
  }
  return true;
}

/** `uname -m` to Docker's platform name. */
export function platformFor(arch: string): string {
  if (arch === 'x86_64' || arch === 'amd64') return 'linux/amd64';
  if (arch === 'aarch64' || arch === 'arm64') return 'linux/arm64';
  throw new Error(`no Docker platform for architecture ${arch}`);
}

/**
 * Hardening and Docker (ADR-0022 item 9's host, #173 exit criterion 4):
 * Docker from its own apt repository with the key checked, a firewall
 * admitting SSH from the operator's addresses only and 80 and 443 from
 * anywhere (items 4 and 7), unattended security upgrades, and SSH by key
 * only. Idempotent: every step is safe to repeat, and the firewall is rebuilt
 * from nothing each time, so a narrowed `--ssh-from` removes the old rules.
 *
 * `init` checks the OS, the sshd include and that this session's own address
 * is in `sshFrom` before anything on the host changes; the same checks here
 * are the second line.
 */
export function hardenScript(sshFrom: readonly string[]): string {
  if (sshFrom.length === 0) throw new Error('no address may reach SSH');
  for (const entry of sshFrom) {
    if (!/^[0-9A-Fa-f.:]+(\/\d{1,3})?$/.test(entry)) throw new Error(`not an address: ${entry}`);
  }
  const sshd = [
    '# Written by ostomy-host init (ADR-0022, D.S1 slice 3).',
    '# sshd keeps the first value it reads for a keyword, and this file sorts',
    '# before any other drop-in, a cloud image\'s "PasswordAuthentication yes" included.',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PermitEmptyPasswords no',
    'PermitRootLogin prohibit-password',
    'AuthenticationMethods publickey',
    'X11Forwarding no',
    'AllowAgentForwarding no',
    // `-L` only: the Keycloak console tunnel. No remote forwards.
    'AllowTcpForwarding local',
    'AllowStreamLocalForwarding no',
    'PermitTunnel no',
    '',
  ].join('\n');
  const enforced = [
    'passwordauthentication no',
    'kbdinteractiveauthentication no',
    'permitrootlogin without-password',
    'authenticationmethods publickey',
    'x11forwarding no',
    'allowagentforwarding no',
    'allowtcpforwarding local',
    'allowstreamlocalforwarding no',
    'permittunnel no',
  ];
  const autoUpgrades = [
    'APT::Periodic::Update-Package-Lists "1";',
    'APT::Periodic::Unattended-Upgrade "1";',
    '',
  ].join('\n');
  const sshdDropIn = '/etc/ssh/sshd_config.d/00-ostomy-hardening.conf';
  return `${PRELUDE}
export DEBIAN_FRONTEND=noninteractive
. /etc/os-release
case "$ID" in ${SUPPORTED_OS.join('|')}) ;; *) echo "unsupported OS: $ID (Debian or Ubuntu only)" >&2; exit 64 ;; esac

# The port this session came in on.
ssh_port="$(printf '%s' "\${SSH_CONNECTION:-}" | awk '{print $4}')"
case "$ssh_port" in ''|*[!0-9]*) echo "cannot tell which port this SSH session uses" >&2; exit 65 ;; esac

# The drop-in below is read only if sshd_config includes its directory.
if ! grep -Eq ${shq(SSHD_INCLUDE_PATTERN)} /etc/ssh/sshd_config; then
  echo "/etc/ssh/sshd_config does not include sshd_config.d/*.conf" >&2; exit 66
fi

# A fresh VPS is often still running cloud-init's own apt when SSH opens.
if command -v cloud-init >/dev/null 2>&1; then cloud-init status --wait >/dev/null 2>&1 || true; fi
apt_get() { apt-get -o DPkg::Lock::Timeout=600 "$@"; }

apt_get update -q
apt_get install -y -q --no-install-recommends ca-certificates curl gnupg ufw unattended-upgrades openssl

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  key="$(mktemp)"
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o "$key"
  # Exactly one key, and it is Docker's: a second key in the file would be
  # trusted for the repository too.
  keys="$(gpg --show-keys --with-colons "$key" | grep -c '^pub:' || true)"
  fpr="$(gpg --show-keys --with-colons "$key" | awk -F: '/^fpr:/ { print $10; exit }')"
  if [ "$keys" != 1 ] || [ "$fpr" != ${shq(DOCKER_APT_KEY_FINGERPRINT)} ]; then
    echo "Docker's apt key file holds $keys key(s), first fingerprint $fpr; expected only ${DOCKER_APT_KEY_FINGERPRINT}" >&2; exit 67
  fi
  install -m 0644 "$key" /etc/apt/keyrings/docker.asc
  rm -f "$key"
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" \\
    >/etc/apt/sources.list.d/docker.list
  apt_get update -q
  apt_get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker

# Docker's published ports bypass ufw (they go through Docker's own chains),
# which is why compose.yml publishes 80 and 443 only, and 8081 on loopback:
# verify's external port scan is what proves the result, not this.
# SSH is not open to the internet at all: only the operator's addresses reach
# it (ADR-0022 items 4 and 7).
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
${sshFrom.map((entry) => `ufw allow proto tcp from ${shq(entry)} to any port "$ssh_port"`).join('\n')}
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

${writeFile('/etc/apt/apt.conf.d/20auto-upgrades', autoUpgrades, '0644')}
systemctl enable --now unattended-upgrades

# A drop-in sshd rejects is put back as it was, or the next sshd restart
# fails and the host is unreachable.
install -d -m 0755 /etc/ssh/sshd_config.d
dropin=${shq(sshdDropIn)}
previous="$(mktemp)"
if [ -f "$dropin" ]; then cp -p "$dropin" "$previous"; had_previous=yes; else had_previous=no; fi
${writeFile(sshdDropIn, sshd, '0644')}
if ! sshd -t; then
  if [ "$had_previous" = yes ]; then mv -f "$previous" "$dropin"; else rm -f "$dropin"; fi
  echo "sshd refused the hardened configuration, which was rolled back" >&2; exit 69
fi
rm -f "$previous"
# sshd -T reports what a new sshd would load, not what the running one
# enforces, so a reload that fails must fail here.
if ! systemctl reload ssh 2>/dev/null && ! systemctl reload sshd 2>/dev/null; then
  echo "could not reload sshd, so the hardened configuration is not in force" >&2; exit 69
fi
effective="$(sshd -T)"
for want in ${enforced.map(shq).join(' ')}; do
  if ! printf '%s\\n' "$effective" | grep -qx "$want"; then
    echo "sshd is not enforcing: $want" >&2; exit 68
  fi
done
`;
}

/**
 * Records the classification, once. `set -C` makes the write fail if the
 * file exists, so two runs racing cannot both succeed with different answers;
 * an existing file with the same answer is a resumed `init`.
 */
export function classifyScript(classification: 'synthetic' | 'real'): string {
  return `${PRELUDE}
install -d -m 0755 ${shq(OSTOMY_ETC)}
if ( set -C; printf '%s\\n' ${shq(classification)} >${shq(CLASSIFICATION_PATH)} ) 2>/dev/null; then
  chmod 0444 ${shq(CLASSIFICATION_PATH)}
  echo created
else
  existing="$(head -n 1 ${shq(CLASSIFICATION_PATH)})"
  if [ "$existing" != ${shq(classification)} ]; then
    echo "this host is already classified $existing" >&2; exit 70
  fi
  echo kept
fi
`;
}

/** The settings file, and the secrets, generated here and never leaving. */
export function configureScript(settingsFile: string, generateSecrets: string): string {
  return `${PRELUDE}
install -d -m 0755 ${shq(OSTOMY_ETC)}
${writeFile(SETTINGS_PATH, settingsFile, '0644')}
generator="$(mktemp)"
trap 'rm -f "$generator"' EXIT
printf '%s' ${shq(Buffer.from(generateSecrets, 'utf8').toString('base64'))} | base64 -d >"$generator"
# The generator prints names only, never a value.
bash "$generator" ${shq(SECRETS_DIR)}
chown -R root:root ${shq(SECRETS_DIR)}
`;
}

export function readFileScript(path: string): string {
  return `${PRELUDE}cat ${shq(path)}\n`;
}

export function releaseDir(name: string): string {
  return `${RELEASES_DIR}/${checkReleaseName(name)}`;
}

/** Unpacks the stack files from stdin (a `git archive` tar) into the release's directory. */
export function installStackScript(name: string, override: string): string {
  const dir = releaseDir(name);
  return `${PRELUDE}
install -d -m 0755 ${shq(RELEASES_DIR)}
staging=${shq(`${dir}.staging`)}
rm -rf "$staging"
mkdir -p "$staging"
tar -x -C "$staging" --no-same-owner
${writeFile(`${dir}.staging/release.override.yml`, override, '0644')}
rm -rf ${shq(dir)}
mv "$staging" ${shq(dir)}
`;
}

/** Loads images from stdin (`docker save`), then refuses unless each tag is the image built. */
export function loadImagesScript(expected: Record<BuiltService, string>, name: string): string {
  const checks = (Object.keys(BUILT) as BuiltService[])
    .map((service) => {
      const tag = `${BUILT[service]}:${checkReleaseName(name)}`;
      const id = expected[service];
      if (!IMAGE_ID.test(id)) throw new Error(`not an image ID: ${JSON.stringify(id)}`);
      return [
        `got="$(docker image inspect --format '{{.Id}}' ${shq(tag)})"`,
        `if [ "$got" != ${shq(id)} ]; then echo ${shq(`${tag} loaded as`)} "$got," ${shq(`expected ${id}`)} >&2; exit 71; fi`,
      ].join('\n');
    })
    .join('\n');
  return `${PRELUDE}
docker load --quiet
${checks}
`;
}

function compose(name: string, commit: string): string {
  const dir = releaseDir(name);
  // compose.yml requires BUILD_COMMIT to interpolate its build arguments,
  // which the override then discards; the value is the release's commit.
  return [
    `BUILD_COMMIT=${shq(commit)} docker compose`,
    `--project-name ${COMPOSE_PROJECT}`,
    `--project-directory ${shq(`${dir}/infra/selfhost`)}`,
    `--env-file ${shq(SETTINGS_PATH)}`,
    `-f ${shq(`${dir}/infra/selfhost/compose.yml`)}`,
    `-f ${shq(`${dir}/release.override.yml`)}`,
  ].join(' ');
}

/**
 * Brings the release up, then prints `service=imageId` for each built service.
 *
 * `--pull missing`, not `never`: caddy, both PostgreSQL and Keycloak come from
 * their registries, pinned by digest in compose.yml, and on a fresh host they
 * exist nowhere else. The built images carry `pull_policy: never` in the
 * override and are already loaded, so nothing pulls them.
 */
export function upScript(name: string, commit: string): string {
  const services = Object.keys(BUILT) as BuiltService[];
  return `${PRELUDE}
${compose(name, commit)} up --detach --no-build --pull missing --remove-orphans --wait --wait-timeout 900
${runningImagesBody(name, commit, services)}
`;
}

function runningImagesBody(
  name: string,
  commit: string,
  services: readonly BuiltService[],
): string {
  return services
    .map(
      (service) =>
        `cid="$(${compose(name, commit)} ps --all --quiet ${service} | head -n 1)"\n` +
        `if [ -n "$cid" ]; then echo "${service}=$(docker inspect --format '{{.Image}}' "$cid")"; else echo "${service}="; fi`,
    )
    .join('\n');
}

export function runningImagesScript(name: string, commit: string): string {
  return `${PRELUDE}${runningImagesBody(name, commit, Object.keys(BUILT) as BuiltService[])}\n`;
}

export function psScript(name: string, commit: string): string {
  return `${PRELUDE}${compose(name, commit)} ps --all --format '{{.Service}}\t{{.State}}\t{{.Health}}'\n`;
}

export function logsScript(name: string, commit: string, service: Service, tail: number): string {
  if (!(SERVICES as readonly string[]).includes(service))
    throw new Error(`unknown service ${service}`);
  if (!Number.isInteger(tail) || tail < 1 || tail > 10_000) throw new Error(`bad tail ${tail}`);
  return `${PRELUDE}${compose(name, commit)} logs --no-color --timestamps --tail ${tail} ${service}\n`;
}

export function recordReleaseScript(record: string): string {
  return `${PRELUDE}${writeFile(RELEASE_RECORD_PATH, record, '0644')}\n`;
}
