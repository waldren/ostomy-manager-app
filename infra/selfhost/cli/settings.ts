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
 * The host's settings file, `/etc/ostomy/selfhost.env`: the values compose.yml
 * reads that are not secrets. `init` writes it from the operator's flags;
 * `deploy` reads it back to build the web image, which bakes the domains in.
 */
import { BlockList, isIP } from 'node:net';

import { Refusal } from './errors.ts';

export const SETTINGS_PATH = '/etc/ostomy/selfhost.env';
export const SECRETS_DIR = '/etc/ostomy/secrets';

export interface HostSettings {
  domain: string;
  authDomain: string;
  acmeEmail: string;
  /** Addresses or CIDR ranges that may reach the admin API and admin realm. */
  adminAllowedIps: string[];
  /**
   * Addresses or CIDR ranges that may reach SSH: the operator's own. The
   * internet sees 80 and 443 only (ADR-0022 items 4 and 7).
   */
  sshAllowedIps: string[];
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[A-Za-z0-9._%+-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/**
 * Ranges that are not a public operator address: private, shared, loopback,
 * link-local, documentation, multicast and reserved space, in both families.
 *
 * The reason is specific (D.S1 slice 2 review). Caddy's `remote_ip` is the
 * real client only while Docker preserves the source address. An IPv6 client
 * reaching a host whose Docker network has no IPv6 arrives through
 * docker-proxy, from the bridge gateway, a 172.x address. With a /32 that
 * fails closed. The obvious "fix", allowing 172.16.0.0/12 or 10.0.0.0/8,
 * would admit every IPv6 client on the internet to the admin surface.
 */
const NOT_PUBLIC: readonly [string, number, 'ipv4' | 'ipv6'][] = [
  ['0.0.0.0', 8, 'ipv4'],
  ['10.0.0.0', 8, 'ipv4'],
  ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'],
  ['169.254.0.0', 16, 'ipv4'],
  ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'],
  ['192.0.2.0', 24, 'ipv4'],
  ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'],
  ['198.51.100.0', 24, 'ipv4'],
  ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'],
  ['240.0.0.0', 4, 'ipv4'],
  ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'],
  ['::ffff:0:0', 96, 'ipv6'],
  ['64:ff9b::', 96, 'ipv6'],
  ['100::', 64, 'ipv6'],
  ['2001::', 23, 'ipv6'],
  ['2001:db8::', 32, 'ipv6'],
  ['fc00::', 7, 'ipv6'],
  ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'],
];

/** The widest range accepted: an operator's own network, never a provider's. */
const MIN_PREFIX = { ipv4: 16, ipv6: 32 } as const;

/** Refuses an allowlist entry that is not a public address or range. */
export function checkAdminAllowEntry(entry: string): string {
  return checkOperatorAddress(entry, '--admin-ip');
}

/**
 * Refuses an operator address, given to `flag`, that is not a public address
 * or range no wider than an operator's own network.
 */
export function checkOperatorAddress(entry: string, flag: string): string {
  const [address, prefixText, extra] = entry.split('/');
  const family = isIP(address ?? '');
  if (extra !== undefined || family === 0) {
    throw new Refusal(`${flag} ${entry}: not an IP address or CIDR range`);
  }
  const type = family === 4 ? 'ipv4' : 'ipv6';
  const max = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  if (!/^\d+$/.test(prefixText ?? String(max)) || prefix > max) {
    throw new Refusal(`${flag} ${entry}: not a valid prefix length`);
  }
  if (prefix < MIN_PREFIX[type]) {
    throw new Refusal(
      `${flag} ${entry}: wider than /${MIN_PREFIX[type]}. The allowlist is the operator's own address, not a provider's network.`,
    );
  }
  const given = new BlockList();
  given.addSubnet(address!, prefix, type);
  for (const [base, bits, blockType] of NOT_PUBLIC) {
    if (blockType !== type) continue;
    const block = new BlockList();
    block.addSubnet(base, bits, blockType);
    // Either range containing the other's base address means they overlap.
    if (block.check(address!, type) || given.check(base, blockType)) {
      throw new Refusal(
        `${flag} ${entry}: overlaps ${base}/${bits}, which is not a public address. ` +
          'Behind Docker, an IPv6 client can arrive from a private bridge address, so a private ' +
          'range here would admit clients you did not intend (see infra/selfhost/README.md).',
      );
    }
  }
  return prefixText === undefined ? address! : `${address}/${prefix}`;
}

export function checkSettings(settings: HostSettings): HostSettings {
  for (const [flag, value] of [
    ['--domain', settings.domain],
    ['--auth-domain', settings.authDomain],
  ] as const) {
    if (!HOSTNAME.test(value)) throw new Refusal(`${flag} ${value}: not a lower-case DNS name`);
  }
  if (settings.domain === settings.authDomain) {
    // ADR-0022 item 5: Keycloak on its own origin, so an XSS in the SPA
    // cannot drive Keycloak's same-origin pages.
    throw new Refusal('--auth-domain must differ from --domain (ADR-0022 item 5)');
  }
  if (!EMAIL.test(settings.acmeEmail)) {
    throw new Refusal(`--acme-email ${settings.acmeEmail}: not an email address`);
  }
  if (settings.adminAllowedIps.length === 0) {
    throw new Refusal('at least one --admin-ip is required');
  }
  if (settings.sshAllowedIps.length === 0) {
    throw new Refusal('at least one --ssh-from is required: SSH is closed to every other address');
  }
  return {
    ...settings,
    adminAllowedIps: settings.adminAllowedIps.map(checkAdminAllowEntry),
    sshAllowedIps: settings.sshAllowedIps.map((entry) => checkOperatorAddress(entry, '--ssh-from')),
  };
}

/** The settings file. Every value was checked to an alphabet with no quoting needs. */
export function renderSettings(settings: HostSettings): string {
  const checked = checkSettings(settings);
  return [
    '# Written by ostomy-host init (infra/selfhost/cli). Holds no secret.',
    '# Changing a domain on a running host breaks every issued token; re-initialise instead.',
    `OSTOMY_SECRETS_DIR=${SECRETS_DIR}`,
    `OSTOMY_DOMAIN=${checked.domain}`,
    `OSTOMY_AUTH_DOMAIN=${checked.authDomain}`,
    `OSTOMY_ACME_EMAIL=${checked.acmeEmail}`,
    `OSTOMY_ADMIN_ALLOWED_IPS=${checked.adminAllowedIps.join(' ')}`,
    '# Not read by Compose: the firewall admits SSH from these only (init).',
    `OSTOMY_SSH_ALLOWED_IPS=${checked.sshAllowedIps.join(' ')}`,
    '',
  ].join('\n');
}

/**
 * Reads a settings file back, as Compose would, and checks it as `init` did:
 * `deploy` bakes these domains into the web image, so a hand-edited file
 * must not reach a build unchecked.
 */
export function parseSettings(text: string): HostSettings {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at === -1) throw new Refusal(`${SETTINGS_PATH}: not KEY=VALUE: ${trimmed}`);
    values.set(trimmed.slice(0, at), trimmed.slice(at + 1));
  }
  const required = (key: string) => {
    const value = values.get(key);
    if (value === undefined || value === '')
      throw new Refusal(`${SETTINGS_PATH}: ${key} is missing`);
    return value;
  };
  return checkSettings({
    domain: required('OSTOMY_DOMAIN'),
    authDomain: required('OSTOMY_AUTH_DOMAIN'),
    acmeEmail: required('OSTOMY_ACME_EMAIL'),
    adminAllowedIps: required('OSTOMY_ADMIN_ALLOWED_IPS').split(/\s+/),
    sshAllowedIps: required('OSTOMY_SSH_ALLOWED_IPS').split(/\s+/),
  });
}
