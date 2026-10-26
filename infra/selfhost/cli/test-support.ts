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
 * Test support: a throwaway repository with real SSH signing keys, and a
 * fake host that records the scripts it is sent. Nothing here is a
 * credential: every key is generated per test run in a temporary directory.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Command, ProcessResult } from './process.ts';
import type { Remote } from './remote.ts';

export function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

export interface SigningKey {
  privateKey: string;
  /** An allowed-signers file naming only this key. */
  allowedSigners: string;
}

/** An ed25519 key pair and its allowed-signers file, in their own directory. */
export function signingKey(label: string): SigningKey {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `ostomy-key-${label}-`)));
  const privateKey = path.join(dir, 'key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', label, '-f', privateKey]);
  const publicKey = readFileSync(`${privateKey}.pub`, 'utf8').trim();
  const allowedSigners = path.join(dir, 'allowed_signers');
  writeFileSync(allowedSigners, `${label}@example.test namespaces="git" ${publicKey}\n`);
  return { privateKey, allowedSigners };
}

/** Writes `files` and commits them. Returns the commit. */
export function commit(repo: string, files: Record<string, string>, message = 'change'): string {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(path.join(repo, file), content);
  }
  git(repo, 'add', '--all');
  git(repo, 'commit', '--quiet', '--no-gpg-sign', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

export function newRepo(files: Record<string, string>): { repo: string; first: string } {
  const repo = realpathSync(mkdtempSync(path.join(tmpdir(), 'ostomy-repo-')));
  git(repo, 'init', '--quiet', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Test Operator');
  git(repo, 'config', 'user.email', 'operator@example.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'tag.gpgsign', 'false');
  return { repo, first: commit(repo, files, 'first') };
}

export function signedTag(repo: string, name: string, key: string, target = 'HEAD'): void {
  git(
    repo,
    '-c',
    'gpg.format=ssh',
    '-c',
    `user.signingkey=${key}`,
    'tag',
    '-s',
    name,
    '-m',
    `release ${name}`,
    target,
  );
}

export interface Sent {
  script: string;
  producer?: Command;
}

/**
 * A host that answers each script with the first matching handler, and
 * records everything it is sent, in order.
 */
export class FakeRemote implements Remote {
  readonly target = 'operator@host.example.test';
  readonly sent: Sent[] = [];
  readonly handlers: [RegExp, (script: string) => Partial<ProcessResult>][] = [];

  on(
    pattern: RegExp,
    answer: Partial<ProcessResult> | ((script: string) => Partial<ProcessResult>),
  ): this {
    this.handlers.unshift([pattern, typeof answer === 'function' ? answer : () => answer]);
    return this;
  }

  private answer(script: string): ProcessResult {
    const handler = this.handlers.find(([pattern]) => pattern.test(script));
    return { code: 0, stdout: '', stderr: '', ...(handler ? handler[1](script) : {}) };
  }

  async exec(script: string): Promise<ProcessResult> {
    this.sent.push({ script });
    return this.answer(script);
  }

  async execFrom(producer: Command, script: string): Promise<ProcessResult> {
    this.sent.push({ script, producer });
    return this.answer(script);
  }
}
