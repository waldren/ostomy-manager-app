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
 * What a host runs: a commit, and for a real host a tag signed in the
 * operator environment (ADR-0022 item 3).
 *
 * The signature is checked by `git verify-tag` against an allowed-signers
 * file the operator keeps outside the repository. In the repository, the
 * development host could edit it, which would make the check meaningless.
 */
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Refusal, Unreachable } from './errors.ts';
import { run, type Command } from './process.ts';

export interface Release {
  /** The name the host records and tags images with: the tag, or `commit-<12 hex>`. */
  name: string;
  commit: string;
  /** The tag, when the release is a verified signed tag. */
  signedTag?: string;
}

const RELEASE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function git(repo: string, args: readonly string[]): Promise<string> {
  const result = await run({ command: 'git', args: ['-C', repo, ...args] });
  if (result.code !== 0) {
    throw new Refusal(`git ${args.join(' ')} failed:\n${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function repoRoot(from: string): Promise<string> {
  const result = await run({ command: 'git', args: ['-C', from, 'rev-parse', '--show-toplevel'] });
  if (result.code !== 0) throw new Unreachable(`${from} is not inside a git checkout`);
  return realpathSync(result.stdout.trim());
}

export async function resolveCommit(repo: string, ref: string): Promise<string> {
  if (ref.startsWith('-')) throw new Refusal(`not a git ref: ${ref}`);
  return (await git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
}

/**
 * Verifies `tag` is an annotated tag, signed with an SSH key listed in
 * `allowedSigners`, and names itself what it is called. Returns the commit.
 */
export async function verifySignedTag(
  repo: string,
  tag: string,
  allowedSigners: string,
): Promise<string> {
  if (!RELEASE_NAME.test(tag)) throw new Refusal(`not a release tag name: ${tag}`);
  const signers = path.resolve(allowedSigners);
  if (!existsSync(signers)) {
    throw new Refusal(
      `the allowed-signers file ${signers} does not exist. It lists the operator environment's ` +
        'tag-signing key, and lives outside the repository (README: "Signing a release").',
    );
  }
  const relative = path.relative(repo, realpathSync(signers));
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) {
    throw new Refusal(
      `${signers} is inside the repository, which the development host can write to. ` +
        'Keep the allowed-signers file in the operator environment only (ADR-0022 item 3).',
    );
  }

  const ref = `refs/tags/${tag}`;
  const type = await run({ command: 'git', args: ['-C', repo, 'cat-file', '-t', ref] });
  if (type.code !== 0) throw new Refusal(`no tag ${tag} in ${repo}`);
  if (type.stdout.trim() !== 'tag') {
    throw new Refusal(
      `${tag} is a lightweight tag, which cannot be signed. Create it with \`git tag -s\`.`,
    );
  }
  const object = await git(repo, ['cat-file', 'tag', ref]);
  // git would also accept an OpenPGP signature, checked against whatever gpg
  // keyring this machine has. Only an SSH signature is checked against the
  // allowed-signers file, so only an SSH signature is accepted.
  if (!object.includes('-----BEGIN SSH SIGNATURE-----')) {
    throw new Refusal(`${tag} is not signed with an SSH key (\`git tag -s\` with gpg.format=ssh)`);
  }
  // A ref can be made to point at another tag's object, signed and genuine,
  // under a new name. The name inside the signed object is the one that counts.
  const named = /^tag (.+)$/m.exec(object)?.[1];
  if (named !== tag) {
    throw new Refusal(
      `refs/tags/${tag} points at a tag object that calls itself ${named ?? 'nothing'}`,
    );
  }
  const verified = await run({
    command: 'git',
    args: [
      '-C',
      repo,
      '-c',
      `gpg.ssh.allowedSignersFile=${signers}`,
      'verify-tag',
      '--end-of-options',
      ref,
    ],
  });
  if (verified.code !== 0) {
    throw new Refusal(
      `${tag}'s signature does not verify against ${signers}:\n${verified.stderr.trim()}`,
    );
  }
  return resolveCommit(repo, ref);
}

/**
 * The release a ref names. A real host takes only a verified signed tag; a
 * synthetic host takes any commit, and records whether it was signed.
 */
export async function resolveRelease(
  repo: string,
  ref: string,
  options: { requireSigned: boolean; allowedSigners: string | undefined },
): Promise<Release> {
  const tagType = await run({
    command: 'git',
    args: ['-C', repo, 'cat-file', '-t', `refs/tags/${ref}`],
  });
  const isAnnotatedTag = tagType.code === 0 && tagType.stdout.trim() === 'tag';
  if (options.requireSigned) {
    if (options.allowedSigners === undefined) {
      throw new Refusal('a real host deploys only a signed tag: pass --allowed-signers <file>');
    }
    const commit = await verifySignedTag(repo, ref, options.allowedSigners);
    return { name: ref, commit, signedTag: ref };
  }
  if (isAnnotatedTag && options.allowedSigners !== undefined) {
    const commit = await verifySignedTag(repo, ref, options.allowedSigners);
    return { name: ref, commit, signedTag: ref };
  }
  const commit = await resolveCommit(repo, ref);
  return { name: `commit-${commit.slice(0, 12)}`, commit };
}

/**
 * Refuses unless this checkout is exactly the release, with no local change.
 *
 * For a real host the CLI that runs must be the reviewed, signed code: a
 * checkout of `main` could carry a tool changed by anything with push access,
 * and that tool is what decides whether the gates pass.
 */
export async function requireCheckoutIs(repo: string, release: Release): Promise<void> {
  const head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  const dirty = (await git(repo, ['status', '--porcelain', '--untracked-files=no'])).trim();
  if (head !== release.commit || dirty !== '') {
    throw new Refusal(
      `for a real host, run this tool from a clean checkout of ${release.name} itself ` +
        `(\`git switch --detach ${release.name}\`): this checkout is at ${head.slice(0, 12)}` +
        (dirty === '' ? '' : ', with local changes'),
    );
  }
}

/** A file's content at `commit`, never from the working copy. */
export async function readAtCommit(repo: string, commit: string, file: string): Promise<string> {
  return git(repo, ['show', `${commit}:${file}`]);
}

/** A clean, detached worktree at `commit`, removed by the returned function. */
export async function withWorktree<T>(
  repo: string,
  commit: string,
  use: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = path.join(mkdtempSync(path.join(tmpdir(), 'ostomy-release-')), 'tree');
  await git(repo, ['worktree', 'add', '--detach', dir, commit]);
  try {
    return await use(dir);
  } finally {
    await run({ command: 'git', args: ['-C', repo, 'worktree', 'remove', '--force', dir] });
  }
}

/** The files a host needs to run the stack, as a tar on stdout. */
export const STACK_FILES = [
  'infra/selfhost/compose.yml',
  'infra/selfhost/caddy',
  'infra/selfhost/keycloak/realms',
] as const;

export function stackArchive(repo: string, commit: string): Command {
  return {
    command: 'git',
    args: ['-C', repo, 'archive', '--format=tar', commit, '--', ...STACK_FILES],
  };
}

export function checkReleaseName(name: string): string {
  if (!RELEASE_NAME.test(name)) throw new Refusal(`not a usable release name: ${name}`);
  return name;
}
