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
 * The release override, merged with compose.yml by Compose itself: no
 * service may be left able to build on the host, and each built service must
 * run its release tag. `!reset` is a Compose feature, so only Compose can
 * say whether it did what the YAML says.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { SELFHOST_ROOT } from '../src/compose-file.ts';
import { BUILT } from './host-scripts.ts';
import { buildEnvironment, releaseOverride, releaseTag } from './images.ts';

function composeAvailable(): boolean {
  try {
    execFileSync('docker', ['compose', 'version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const available = composeAvailable();
if (!available) {
  if (process.env.CI)
    throw new Error('[override.integration.spec.ts] docker compose is missing, but CI is set.');
  console.warn('[override.integration.spec.ts] docker compose is missing — skipping.');
}

describe.skipIf(!available)('the release override, as Compose merges it', () => {
  it('leaves nothing to build, and runs each built service from its release tag, never pulled', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ostomy-override-'));
    const override = path.join(dir, 'release.override.yml');
    writeFileSync(override, releaseOverride('v1.2.3'));
    const settings = {
      domain: 'diary.example.org',
      authDomain: 'auth.diary.example.org',
      acmeEmail: 'operator@example.org',
      adminAllowedIps: ['8.8.4.4'],
      sshAllowedIps: ['8.8.8.8'],
    };
    const result = spawnSync(
      'docker',
      [
        'compose',
        '-f',
        path.join(SELFHOST_ROOT, 'compose.yml'),
        '-f',
        override,
        'config',
        '--format',
        'json',
      ],
      { encoding: 'utf8', env: buildEnvironment(settings, 'c'.repeat(40), 'linux/amd64') },
    );
    expect(result.stderr).not.toMatch(/error/i);
    expect(result.status).toBe(0);
    const config = JSON.parse(result.stdout) as {
      services: Record<string, { build?: unknown; image?: string; pull_policy?: string }>;
    };
    for (const [name, service] of Object.entries(config.services)) {
      expect({ name, build: service.build }).toEqual({ name, build: undefined });
    }
    for (const service of Object.keys(BUILT) as (keyof typeof BUILT)[]) {
      expect(config.services[service]).toMatchObject({
        image: releaseTag(service, 'v1.2.3'),
        pull_policy: 'never',
      });
    }
  });
});
