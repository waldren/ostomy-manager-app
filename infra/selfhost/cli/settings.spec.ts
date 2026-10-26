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

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SELFHOST_ROOT } from '../src/compose-file.ts';
import { buildEnvironment } from './images.ts';
import {
  checkAdminAllowEntry,
  checkSettings,
  parseSettings,
  renderSettings,
  type HostSettings,
} from './settings.ts';

const valid: HostSettings = {
  domain: 'diary.example.org',
  authDomain: 'auth.diary.example.org',
  acmeEmail: 'operator@example.org',
  adminAllowedIps: ['8.8.4.4'],
  sshAllowedIps: ['8.8.8.8'],
};

describe('the admin allowlist takes public addresses only', () => {
  it.each(['8.8.4.4', '8.8.4.0/24', '8.8.0.0/16', '2001:4860:4860::8888', '2001:4860::/32'])(
    'accepts %s',
    (entry) => {
      expect(checkAdminAllowEntry(entry)).toBe(entry);
    },
  );

  // Behind Docker an IPv6 client can arrive from the bridge gateway, a 172.x
  // address; a private range here would admit it (D.S1 slice 2 review).
  it.each([
    '10.0.0.0/8',
    '172.17.0.1',
    '172.16.0.0/12',
    '192.168.1.10',
    '127.0.0.1',
    '100.64.0.1',
    '169.254.1.1',
    '0.0.0.0/0',
    '::/0',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:10.0.0.1',
    '203.0.113.10',
    '2001:db8::1',
  ])('refuses %s', (entry) => {
    expect(() => checkAdminAllowEntry(entry)).toThrow();
  });

  it.each(['8.0.0.0/8', '2001::/16'])(
    'refuses %s, which is wider than one operator’s network',
    (entry) => {
      expect(() => checkAdminAllowEntry(entry)).toThrow(/wider than/);
    },
  );

  it.each(['8.8.4.4/33', '8.8.4.4/x', '8.8.4.4/24/1', 'example.org', '8.8.4.4 1.1.1.1'])(
    'refuses malformed %j',
    (entry) => {
      expect(() => checkAdminAllowEntry(entry)).toThrow(/not/);
    },
  );
});

describe('the host settings', () => {
  it.each([
    ['an upper-case domain', { domain: 'Diary.example.org' }],
    ['a domain with a space', { domain: 'diary example.org' }],
    ['the same name for both', { authDomain: 'diary.example.org' }],
    ['a malformed email', { acmeEmail: 'operator' }],
    ['no admin address', { adminAllowedIps: [] }],
    ['no SSH address', { sshAllowedIps: [] }],
    ['a private SSH address', { sshAllowedIps: ['192.168.1.10'] }],
    ['an SSH range wider than one network', { sshAllowedIps: ['8.0.0.0/8'] }],
    ['a newline smuggled into a value', { acmeEmail: 'a@example.org\nOSTOMY_DOMAIN=evil.example' }],
  ])('refuses %s', (_name, change) => {
    expect(() => checkSettings({ ...valid, ...change })).toThrow();
  });

  it('round-trips through the file Compose reads', () => {
    const settings = { ...valid, adminAllowedIps: ['8.8.4.4', '2001:4860::/32'] };
    expect(parseSettings(renderSettings(settings))).toEqual(settings);
  });

  // deploy builds the web image from these; a hand-edited file must not
  // reach a build unchecked.
  it('refuses a settings file edited on the host into something init would refuse', () => {
    const edited = renderSettings(valid).replace(
      'OSTOMY_DOMAIN=diary.example.org',
      'OSTOMY_DOMAIN=Evil Example',
    );
    expect(() => parseSettings(edited)).toThrow(/not a lower-case DNS name/);
  });

  // Each `${NAME:?...}` compose.yml requires must come from the settings file,
  // the build environment, or (BUILD_COMMIT) the deploy itself.
  it('supplies every variable compose.yml requires, at build and at run', () => {
    const compose = readFileSync(path.join(SELFHOST_ROOT, 'compose.yml'), 'utf8');
    const required = new Set([...compose.matchAll(/\$\{([A-Z_]+):\?/g)].map((match) => match[1]!));
    const rendered = new Set(
      [...renderSettings(valid).matchAll(/^([A-Z_]+)=/gm)].map((match) => match[1]!),
    );
    expect([...required].filter((name) => !rendered.has(name))).toEqual(['BUILD_COMMIT']);
    const environment = buildEnvironment(valid, 'a'.repeat(40), 'linux/amd64');
    expect([...required].filter((name) => !environment[name])).toEqual([]);
  });
});
