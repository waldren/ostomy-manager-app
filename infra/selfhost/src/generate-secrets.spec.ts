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

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readComposeFile, SELFHOST_ROOT } from './compose-file';

const SCRIPT = path.join(SELFHOST_ROOT, 'bin/generate-secrets.sh');

describe('bin/generate-secrets.sh', () => {
  let work: string;
  let dir: string;

  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), 'ostomy-secrets-'));
    dir = path.join(work, 'secrets');
  });
  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
  });

  const run = () => execFileSync('bash', [SCRIPT, dir], { encoding: 'utf8' });

  it('creates every secret compose.yml names, and only those', () => {
    run();
    const expected = Object.keys(readComposeFile().secrets).sort();
    expect(readdirSync(dir).sort()).toEqual(expected);
  });

  it('writes 64 hex characters with no newline, different for each', () => {
    run();
    const values = readdirSync(dir).map((name) => readFileSync(path.join(dir, name), 'utf8'));
    for (const value of values) expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set(values).size).toBe(values.length);
  });

  it('prints names and never a value', () => {
    const output = run();
    for (const name of readdirSync(dir)) {
      expect(output).toContain(`created ${name}`);
      expect(output).not.toContain(readFileSync(path.join(dir, name), 'utf8'));
    }
  });

  /** Replacing a database password under a running volume locks the stack out of its own data. */
  it('keeps a secret that already exists', () => {
    run();
    // Read-only by design, so replaced rather than written over.
    rmSync(path.join(dir, 'db_runtime_password'));
    writeFileSync(path.join(dir, 'db_runtime_password'), 'existing');
    const output = run();
    expect(readFileSync(path.join(dir, 'db_runtime_password'), 'utf8')).toBe('existing');
    expect(output).toContain('kept    db_runtime_password');
  });

  // Windows has no POSIX modes to assert; the host is Linux.
  it.skipIf(process.platform === 'win32')(
    'makes the directory root-only and each file readable inside it',
    () => {
      run();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      for (const name of readdirSync(dir)) {
        expect(statSync(path.join(dir, name)).mode & 0o777).toBe(0o444);
      }
    },
  );
});
